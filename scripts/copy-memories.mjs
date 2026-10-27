#!/usr/bin/env node
// Nothing reaches stdout or stderr but ids, counts, scope labels and codes: memory content and credentials stay out.
import { parseArgs } from 'node:util';
import { assertSafeUrl, isEntryPoint, UsageError } from './lib/cli.mjs';
import { createClient, memoryPages, postBatches } from './lib/memory-api.mjs';

const MAX_BATCH_SIZE = 100;
// The whole source is held to order it successor-first; past this many characters of row JSON the copy refuses
// before it writes anything.
const MAX_BUFFERED_CHARS = 256 * 1024 * 1024;
const FROM_AUTHORIZATION = 'AGENT_MEMORY_FROM_AUTHORIZATION';
const TO_AUTHORIZATION = 'AGENT_MEMORY_TO_AUTHORIZATION';
const OPTIONAL_FIELDS = [
	'title',
	'supersededBy',
	'validUntil',
	'withdrawnAt',
	'withdrawnReason',
	'contentFlag',
	'needsReview',
];
const COMPARED_FIELDS = [
	'ownerId',
	'title',
	'content',
	'tags',
	'evidence',
	'scopes',
	'status',
	'supersedes',
	'supersededBy',
	'createdAt',
	'validUntil',
	'withdrawnAt',
	'withdrawnReason',
	'needsReview',
];

export function toImportRow(view) {
	const row = {
		id: view.id,
		ownerId: view.ownerId,
		content: view.content,
		tags: view.tags ?? [],
		evidence: view.evidence ?? [],
		scopes: view.scopes,
		status: view.status,
		supersedes: view.supersedes ?? [],
		createdAt: view.createdAt,
	};
	for (const field of OPTIONAL_FIELDS) if (view[field] != null) row[field] = view[field];
	return row;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields where a row differs from the row the copy intends. Unless `exact`, the row may carry a content flag the
 * intended row lacks (the target's own check matched more), never lack one.
 */
export function differences(intended, view, exact = false) {
	const actual = toImportRow(view);
	const fields = COMPARED_FIELDS.filter((field) => !same(intended[field], actual[field]));
	if ((exact || intended.contentFlag) && !same(intended.contentFlag, actual.contentFlag)) fields.push('contentFlag');
	return fields;
}

/**
 * Successors before the rows they supersede, so the target never stores a row before its live replacement: a
 * replacement arriving later would turn it superseded and flag its citers, a review the source never asked for.
 * Withdrawn rows supersede nothing. A row left over lies on a supersession cycle, which has no such order.
 */
export function successorOrder(rows) {
	const ids = new Set(rows.map((row) => row.id));
	const pending = new Map();
	for (const row of rows) {
		if (row.status === 'withdrawn') continue;
		for (const target of row.supersedes) if (ids.has(target)) pending.set(target, (pending.get(target) ?? 0) + 1);
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	const newestFirst = [...rows].sort((a, b) =>
		a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
	);
	const order = newestFirst.filter((row) => !pending.has(row.id));
	for (let next = 0; next < order.length; next++) {
		const row = order[next];
		if (row.status === 'withdrawn') continue;
		for (const target of row.supersedes) {
			const remaining = pending.get(target);
			if (remaining === undefined) continue;
			if (remaining > 1) pending.set(target, remaining - 1);
			else {
				pending.delete(target);
				order.push(byId.get(target));
			}
		}
	}
	if (pending.size > 0) {
		throw new Error(`the source has a supersession cycle through ${[...pending.keys()].sort().join(', ')}`);
	}
	return order;
}

const increment = (counts, key) => (counts[key] = (counts[key] ?? 0) + 1);

async function readSource(request, { maxBufferedChars, stderr }) {
	const rows = [];
	const summary = { memories: 0, byStatus: {}, byScope: {}, contentFlagged: 0, needsReview: 0, notCarried: {} };
	let chars = 0;
	for await (const page of memoryPages(request, { includeWithdrawn: true })) {
		for (const view of page) {
			chars += JSON.stringify(view).length;
			if (chars > maxBufferedChars) {
				throw new Error(`the source holds more than ${maxBufferedChars} characters of memories; nothing was written`);
			}
			rows.push(toImportRow(view));
			summary.memories++;
			increment(summary.byStatus, view.status);
			for (const label of view.scopes) increment(summary.byScope, label);
			if (view.contentFlag) summary.contentFlagged++;
			if (view.needsReview) summary.needsReview++;
			if (view.confirmed) increment(summary.notCarried, 'confirmed');
			if (view.scopeConfirmed) increment(summary.notCarried, 'scopeConfirmed');
			if (view.autoSupersedes?.length) increment(summary.notCarried, 'autoSupersedes');
		}
		stderr.write(`read ${rows.length} source memories\n`);
	}
	return { rows, summary };
}

async function compareRows(request, intended, stderr, exact = false) {
	const foreign = [];
	const mismatched = [];
	const seen = new Set();
	for await (const page of memoryPages(request, { includeWithdrawn: true })) {
		for (const view of page) {
			const row = intended.get(view.id);
			if (!row) {
				foreign.push(view.id);
				continue;
			}
			seen.add(view.id);
			const fields = differences(row, view, exact);
			if (fields.length > 0) mismatched.push({ id: view.id, fields });
		}
		stderr.write(`compared ${seen.size + foreign.length} memories\n`);
	}
	const missing = [...intended.keys()].filter((id) => !seen.has(id));
	return { present: seen.size, missing, foreign, mismatched };
}

const OPTIONS = {
	from: { type: 'string' },
	to: { type: 'string' },
	'batch-size': { type: 'string', default: String(MAX_BATCH_SIZE) },
	'dry-run': { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
};

const USAGE = `Usage: node scripts/copy-memories.mjs --from <url> --to <url> [--batch-size <1-${MAX_BATCH_SIZE}>]
       node scripts/copy-memories.mjs --from <url> [--to <url>] --dry-run

Copies every memory, withdrawn and superseded ones included, from one agent-memory instance into another that holds
no other memories. The target is checked before anything is written and verified afterwards; a re-run resumes.
--dry-run reads only: source counts by status and scope, and the target check when --to is given.

Environment: ${FROM_AUTHORIZATION}, ${TO_AUTHORIZATION}: the Authorization header value (for example
"Basic <base64>" or "Bearer <token>") of a super_user on each instance.
`;

function authorization(env, name) {
	const value = env[name];
	if (!value) throw new UsageError(`set ${name} in the environment`);
	return value;
}

export async function run(
	argv,
	env,
	{ stdout = process.stdout, stderr = process.stderr, maxBufferedChars = MAX_BUFFERED_CHARS } = {},
) {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) {
			stdout.write(USAGE);
			return 0;
		}
		if (!values.from) throw new UsageError('--from is required');
		if (!values.to && !values['dry-run']) throw new UsageError('--to is required unless --dry-run');
		const batchSize = Number(values['batch-size']);
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
			throw new UsageError(`--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
		}
		const from = assertSafeUrl(values.from, '--from');
		const to = values.to && assertSafeUrl(values.to, '--to');
		if (to === from) throw new UsageError('--from and --to name the same instance');
		const fromRequest = createClient(from, authorization(env, FROM_AUTHORIZATION));
		const toAuthorization = to && authorization(env, TO_AUTHORIZATION);

		const { rows, summary } = await readSource(fromRequest, { maxBufferedChars, stderr });
		const ordered = successorOrder(rows);
		const intended = new Map(ordered.map((row) => [row.id, row]));
		const report = { source: summary };
		if (!to) {
			stdout.write(JSON.stringify(report, null, '\t') + '\n');
			return 0;
		}

		const toRequest = createClient(to, toAuthorization);
		const preflight = await compareRows(toRequest, intended, stderr);
		report.preflight = { present: preflight.present, foreign: preflight.foreign, mismatched: preflight.mismatched };
		if (preflight.foreign.length > 0 || preflight.mismatched.length > 0) {
			report.refused = 'the target holds memories that are not this copy of the source; nothing was written';
			stdout.write(JSON.stringify(report, null, '\t') + '\n');
			return 1;
		}
		if (values['dry-run']) {
			stdout.write(JSON.stringify(report, null, '\t') + '\n');
			return 0;
		}

		let imported;
		try {
			imported = await postBatches(ordered, { target: to, authorization: toAuthorization, batchSize, stderr });
		} catch (error) {
			if (error.partialResult) report.imported = error.partialResult;
			stdout.write(JSON.stringify(report, null, '\t') + '\n');
			throw error;
		}
		report.imported = {
			created: imported.created,
			unchanged: imported.unchanged,
			conflict: imported.conflict,
			conflicts: imported.conflicts,
		};
		let verified;
		let recheck;
		try {
			verified = await compareRows(toRequest, intended, stderr);
			report.verified = verified;
			// A write, or a model's content verdict, that landed on the source after it was read is not in the copy.
			recheck = await compareRows(fromRequest, intended, stderr, true);
		} catch (error) {
			stdout.write(JSON.stringify(report, null, '\t') + '\n');
			throw error;
		}
		report.sourceChanged = { new: recheck.foreign, changed: recheck.mismatched, gone: recheck.missing };
		const empty = (...lists) => lists.every((list) => list.length === 0);
		const complete =
			imported.conflict === 0 &&
			empty(verified.missing, verified.foreign, verified.mismatched) &&
			empty(recheck.missing, recheck.foreign, recheck.mismatched);
		if (!complete) report.incomplete = 'the target does not match the source; see verified and sourceChanged';
		stdout.write(JSON.stringify(report, null, '\t') + '\n');
		return complete ? 0 : 1;
	} catch (error) {
		stderr.write(`copy-memories: ${error.message}\n`);
		if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
			stderr.write(USAGE);
			return 2;
		}
		return 1;
	}
}

if (isEntryPoint(import.meta.filename)) process.exitCode = await run(process.argv.slice(2), process.env);
