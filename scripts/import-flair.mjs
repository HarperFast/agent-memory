#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, link, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	buildReport,
	classifyCandidates,
	draftLessons,
	lessonRow,
	parseOrgMap,
	readDecisions,
	reportSummary,
} from './lib/customer-content.mjs';

export const MAX_BATCH_SIZE = 100;
export const DEFAULT_MAX_CONTENT_CHARS = 20_000;
const MAX_CONTENT_CHARS_LIMIT = 100_000;
const TAGS_MAX_ITEMS = 20;
const TAG_MAX_CHARS = 64;
const REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const CLASSIFIERS = new Set(['claude', 'anthropic']);
const FLAIR_FIELDS = [
	'id',
	'agentId',
	'content',
	'visibility',
	'tags',
	'durability',
	'createdAt',
	'validTo',
	'supersedes',
	'archived',
	'archivedAt',
	'expiresAt',
];
const IMPORT_RESULTS = new Set(['created', 'unchanged', 'conflict']);
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);

class UsageError extends Error {}

export function memoryIdFor(flairId) {
	return createHash('sha256').update(`flair:${flairId}`).digest('hex').slice(0, 32);
}

function isValidPrincipalId(id) {
	return typeof id === 'string' && id.length > 0 && id.length <= 122 && !/[\s:*]/.test(id);
}

export function parsePrincipalMap(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('principal map must be a JSON object of { "<flairAgentId>": "<harperUsername>" }');
	}
	const principalMap = new Map();
	for (const [agentId, username] of Object.entries(value)) {
		if (!isValidPrincipalId(username)) {
			throw new Error(
				`principal map entry ${JSON.stringify(agentId)} must map to a Harper username without whitespace, ":" or "*", at most 122 characters`,
			);
		}
		principalMap.set(agentId, username);
	}
	return principalMap;
}

export function parseJsonl(text) {
	const rows = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].trim()) continue;
		try {
			rows.push(JSON.parse(lines[index]));
		} catch {
			throw new Error(`line ${index + 1} is not valid JSON`);
		}
	}
	return rows;
}

function isDateString(value) {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOptional(value, check) {
	return value === undefined || value === null || check(value);
}

function flairRowProblem(row) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return 'is not an object';
	if (typeof row.id !== 'string' || !row.id) return 'has no string id';
	if (typeof row.agentId !== 'string' || !row.agentId) return 'has no string agentId';
	if (typeof row.content !== 'string') return 'has no string content';
	if (!isDateString(row.createdAt)) return 'has no valid createdAt';
	if (!isOptional(row.tags, (tags) => Array.isArray(tags) && tags.every((tag) => typeof tag === 'string'))) {
		return 'has tags that are not a list of strings';
	}
	for (const field of ['visibility', 'durability', 'supersedes']) {
		if (!isOptional(row[field], (value) => typeof value === 'string')) return `has a non-string ${field}`;
	}
	for (const field of ['validTo', 'archivedAt', 'expiresAt']) {
		if (!isOptional(row[field], isDateString)) return `has an invalid ${field}`;
	}
	if (!isOptional(row.archived, (value) => typeof value === 'boolean')) return 'has a non-boolean archived';
	return null;
}

function validateFlairRow(row, index) {
	const problem = flairRowProblem(row);
	if (problem) {
		const label = typeof row?.id === 'string' ? `Flair memory ${JSON.stringify(row.id)}` : `Flair memory #${index + 1}`;
		throw new Error(`${label} ${problem}`);
	}
}

function flairRowLimitReason(row, maxContentChars) {
	const contentLength = row.content.trim().length;
	if (contentLength === 0) return 'content_required';
	if (contentLength > maxContentChars) return 'content_too_long';
	if (row.tags) {
		if (row.tags.length > TAGS_MAX_ITEMS) return 'tags_too_many';
		for (const tag of row.tags) {
			const trimmed = tag.trim();
			if (trimmed.length === 0) return 'invalid_tags';
			if (trimmed.length > TAG_MAX_CHARS) return 'tags_too_long';
		}
	}
	return null;
}

function increment(counts, key) {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * `scopeOverrides` (Flair id → labels) replaces `global` for non-private rows, before links are resolved, so the
 * reader rule below sees the scopes that will be sent.
 */
export function mapFlairMemories(
	flairRows,
	principalMap,
	{ maxContentChars = DEFAULT_MAX_CONTENT_CHARS, scopeOverrides } = {},
) {
	if (!Number.isInteger(maxContentChars) || maxContentChars < 1 || maxContentChars > MAX_CONTENT_CHARS_LIMIT) {
		throw new Error(`maxContentChars must be an integer from 1 to ${MAX_CONTENT_CHARS_LIMIT}`);
	}
	const byFlairId = new Map();
	const createdMs = new Map();
	flairRows.forEach((row, index) => {
		validateFlairRow(row, index);
		if (byFlairId.has(row.id)) throw new Error(`Flair memory ${JSON.stringify(row.id)} appears more than once`);
		byFlairId.set(row.id, row);
		createdMs.set(row.id, Date.parse(row.createdAt));
	});
	const compareByCreated = (a, b) => createdMs.get(a) - createdMs.get(b) || (a < b ? -1 : a > b ? 1 : 0);

	const unmappedAgents = new Map();
	const byOwner = new Map();
	const byScope = new Map();
	const unknownVisibility = new Map();
	const byStatus = { active: 0, superseded: 0, withdrawn: 0 };
	const unresolved = [];
	const invalid = [];
	let ephemeral = 0;

	const eligible = new Map();
	for (const flairId of [...byFlairId.keys()].sort(compareByCreated)) {
		const row = byFlairId.get(flairId);
		const ownerId = principalMap.get(row.agentId);
		if (ownerId === undefined) {
			increment(unmappedAgents, row.agentId);
			continue;
		}
		// Flair stamps expiresAt only on the ephemeral tier; the target has no expiry, so importing would
		// make self-pruning working state permanent.
		if (row.durability === 'ephemeral' || row.expiresAt != null) {
			ephemeral++;
			continue;
		}
		const limitReason = flairRowLimitReason(row, maxContentChars);
		if (limitReason) {
			invalid.push({ id: row.id, reason: limitReason });
			continue;
		}
		// Flair reads only the literal "private" as owner-only; any other value is readable by every agent.
		const scopes = row.visibility === 'private' ? [`user:${ownerId}`] : (scopeOverrides?.get(row.id) ?? ['global']);
		if (row.visibility != null && row.visibility !== 'private' && row.visibility !== 'shared') {
			increment(unknownVisibility, row.visibility);
		}
		eligible.set(row.id, { flair: row, id: memoryIdFor(row.id), ownerId, scopes });
	}

	const predecessorOf = new Map();
	for (const entry of eligible.values()) {
		const target = entry.flair.supersedes;
		if (!target) continue;
		const predecessor = eligible.get(target);
		// `global` covers every imported principal, as the visibility mapping already assumes.
		const narrows =
			predecessor &&
			!entry.scopes.includes('global') &&
			predecessor.scopes.some((label) => !entry.scopes.includes(label));
		const reason =
			target === entry.flair.id
				? 'self'
				: !byFlairId.has(target)
					? 'missing'
					: !predecessor
						? 'skipped'
						: narrows
							? 'narrowing'
							: null;
		if (reason) unresolved.push({ from: entry.flair.id, to: target, reason });
		else predecessorOf.set(entry.flair.id, target);
	}

	// Each row supersedes at most one row, so rows still pending after this pass lie on closed loops,
	// which have no successor-first order.
	const successorCount = new Map();
	for (const target of predecessorOf.values()) successorCount.set(target, (successorCount.get(target) ?? 0) + 1);
	const order = [];
	const pending = new Map(successorCount);
	const queue = [...eligible.keys()].filter((flairId) => !pending.has(flairId));
	for (let next = 0; next < queue.length; next++) {
		const flairId = queue[next];
		order.push(flairId);
		const target = predecessorOf.get(flairId);
		if (target === undefined) continue;
		const remaining = pending.get(target) - 1;
		if (remaining) pending.set(target, remaining);
		else {
			pending.delete(target);
			queue.push(target);
		}
	}
	const onCycle = [...eligible.keys()].filter((flairId) => pending.has(flairId));
	for (const flairId of onCycle) {
		unresolved.push({ from: flairId, to: predecessorOf.get(flairId), reason: 'cycle' });
		predecessorOf.delete(flairId);
		order.push(flairId);
	}

	const compareByTargetNewest = (a, b) => {
		const delta = createdMs.get(a) - createdMs.get(b);
		if (delta !== 0) return delta;
		const idA = eligible.get(a).id;
		const idB = eligible.get(b).id;
		return idA < idB ? -1 : idA > idB ? 1 : 0;
	};
	const latestLiveSuccessor = new Map();
	for (const flairId of order) {
		const target = predecessorOf.get(flairId);
		if (target === undefined || byFlairId.get(flairId).archived === true || byFlairId.get(target).archived === true) {
			continue;
		}
		const current = latestLiveSuccessor.get(target);
		if (!current || compareByTargetNewest(current, flairId) < 0) latestLiveSuccessor.set(target, flairId);
	}

	const rows = order.map((flairId) => {
		const { flair, id, ownerId, scopes } = eligible.get(flairId);
		const successor = latestLiveSuccessor.get(flairId);
		const status = flair.archived === true ? 'withdrawn' : successor ? 'superseded' : 'active';
		const row = { id, ownerId, content: flair.content, scopes, status, createdAt: flair.createdAt };
		if (flair.tags?.length) row.tags = flair.tags;
		const target = predecessorOf.get(flairId);
		if (target !== undefined) row.supersedes = [eligible.get(target).id];
		if (successor) row.supersededBy = eligible.get(successor).id;
		if (flair.validTo != null) row.validUntil = flair.validTo;
		if (status === 'withdrawn') {
			if (flair.archivedAt != null) row.withdrawnAt = flair.archivedAt;
			row.withdrawnReason = 'archived in Flair';
		}
		increment(byOwner, ownerId);
		for (const label of scopes) increment(byScope, label);
		byStatus[status]++;
		return row;
	});
	const summary = {
		source: 'flair',
		read: flairRows.length,
		toImport: rows.length,
		skipped: { unmappedAgents: Object.fromEntries(unmappedAgents), ephemeral, invalid },
		byOwner: Object.fromEntries(byOwner),
		byScope: Object.fromEntries(byScope),
		byStatus,
		unknownVisibility: Object.fromEntries(unknownVisibility),
		supersedes: { resolved: predecessorOf.size, unresolved },
	};
	return { rows, summary };
}

function flairFingerprint(flairRow, ownerId) {
	const fields = [ownerId, ...FLAIR_FIELDS.map((field) => flairRow[field] ?? null)];
	return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function classificationCandidates(flairRows, principalMap, options) {
	const { rows } = mapFlairMemories(flairRows, principalMap, options);
	const flairById = new Map(flairRows.map((flairRow) => [memoryIdFor(flairRow.id), flairRow]));
	return rows
		.filter((row) => row.scopes.length === 1 && row.scopes[0] === 'global')
		.map((row) => {
			const flairRow = flairById.get(row.id);
			return {
				id: row.id,
				flairId: flairRow.id,
				ownerId: row.ownerId,
				content: row.content,
				tags: row.tags ?? [],
				validUntil: row.validUntil ?? null,
				fingerprint: flairFingerprint(flairRow, row.ownerId),
			};
		});
}

function assertSafeUrl(value, name) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new UsageError(`${name} is not a valid URL`);
	}
	if (url.username || url.password) {
		throw new UsageError(`${name} must not embed credentials; pass them through environment variables`);
	}
	const loopback = LOOPBACK_HOSTS.has(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new UsageError(`${name} must use https (plain http is allowed only for loopback hosts)`);
	}
	if (url.search || url.hash) throw new UsageError(`${name} must not carry a query or fragment`);
	return url.origin + url.pathname.replace(/\/+$/, '');
}

function basicAuth(env, userVar, passVar, defaultUser) {
	const user = env[userVar] || defaultUser;
	const pass = env[passVar];
	if (!user || !pass) {
		throw new UsageError(`set ${defaultUser ? '' : `${userVar} and `}${passVar} in the environment`);
	}
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function requestFailureCode(error) {
	const candidate = error?.cause?.code ?? error?.code ?? error?.name;
	return typeof candidate === 'string' && ERROR_CODE.test(candidate) ? candidate : 'request_failed';
}

async function readFlairLive(flairBase, authorization) {
	let response;
	try {
		response = await fetch(`${flairBase}/Memory/?select(${FLAIR_FIELDS.join(',')})`, {
			headers: { Authorization: authorization, Accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`reading Flair memories failed: ${requestFailureCode(error)}`, { cause: error });
	}
	if (!response.ok) throw new Error(`reading Flair memories failed: HTTP ${response.status}`);
	let rows;
	try {
		// A JSON parse error message quotes the body, which is memory content.
		rows = await response.json();
	} catch (error) {
		if (error?.name !== 'SyntaxError') {
			throw new Error(`reading Flair memories failed: ${requestFailureCode(error)}`, { cause: error });
		}
		rows = null;
	}
	if (!Array.isArray(rows)) throw new Error('reading Flair memories failed: response is not a JSON array');
	return rows;
}

async function errorDetail(response, rows) {
	try {
		const body = await response.json();
		const parts = [];
		if (typeof body?.code === 'string' && ERROR_CODE.test(body.code)) parts.push(`code ${body.code}`);
		if (Number.isInteger(body?.index) && rows[body.index]) {
			parts.push(`row ${body.index} (${rows[body.index].id})`);
		}
		return parts.length ? `, ${parts.join(', ')}` : '';
	} catch {
		return '';
	}
}

async function postBatches(rows, { target, authorization, batchSize, stderr, label = 'batch' }) {
	const url = `${target}/Memory/import`;
	const result = { created: 0, unchanged: 0, conflict: 0, conflicts: [], dependsOnConflict: [] };
	const conflictIds = new Set();
	const batchCount = Math.ceil(rows.length / batchSize);
	const failBatch = (batch, detail, cause) => {
		const error = new Error(
			`${label} ${batch}/${batchCount} failed: ${detail}; earlier batches are committed and a re-run resumes`,
			cause ? { cause } : undefined,
		);
		if (batch > 1) error.partialResult = result;
		return error;
	};
	for (let start = 0, batch = 1; start < rows.length; start += batchSize, batch++) {
		const batchRows = rows.slice(start, start + batchSize);
		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({ rows: batchRows }),
				redirect: 'error',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw failBatch(batch, requestFailureCode(error), error);
		}
		if (!response.ok) {
			throw failBatch(batch, `HTTP ${response.status}${await errorDetail(response, batchRows)}`);
		}
		let body;
		try {
			body = await response.json();
		} catch (error) {
			if (error?.name !== 'SyntaxError') throw failBatch(batch, requestFailureCode(error), error);
			body = null;
		}
		const results = body?.results;
		if (
			!Array.isArray(results) ||
			results.length !== batchRows.length ||
			!results.every((entry, index) => entry?.id === batchRows[index].id && IMPORT_RESULTS.has(entry.result))
		) {
			throw failBatch(batch, 'response does not carry one result per row in order');
		}
		results.forEach((entry) => {
			result[entry.result]++;
			if (entry.result === 'conflict') {
				conflictIds.add(entry.id);
				result.conflicts.push({ id: entry.id });
			}
		});
		// Successors come first, so a conflicted successor is already known when its predecessor's result arrives.
		results.forEach((entry, index) => {
			const { id, supersededBy } = batchRows[index];
			if (entry.result !== 'conflict' && conflictIds.has(supersededBy)) {
				result.dependsOnConflict.push({ id, supersededBy });
			}
		});
		stderr.write(`${label} ${batch}/${batchCount}: ${batchRows.length} rows\n`);
	}
	return result;
}

async function sourceStatus(id, { target, authorization }) {
	let response;
	try {
		response = await fetch(`${target}/Memory/${id}`, {
			headers: { Authorization: authorization, Accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`checking source ${id} failed: ${requestFailureCode(error)}`, { cause: error });
	}
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`checking source ${id} failed: HTTP ${response.status}`);
	let body;
	try {
		body = await response.json();
	} catch (error) {
		throw new Error(`checking source ${id} failed: ${requestFailureCode(error)}`, { cause: error });
	}
	return typeof body?.memory?.status === 'string' ? body.memory.status : null;
}

async function importLessons(lessonRows, skipped, sourceResult, options) {
	const conflicted = new Set(sourceResult.conflicts.map((conflict) => conflict.id));
	const ready = [];
	for (const row of lessonRows) {
		const sourceId = row.evidence[0].ref;
		const reason = conflicted.has(sourceId)
			? 'source_conflict'
			: (await sourceStatus(sourceId, options)) !== 'active'
				? 'source_not_active'
				: null;
		if (reason) skipped.push({ id: row.id, source: sourceId, reason });
		else ready.push(row);
	}
	const result = ready.length ? await postBatches(ready, { ...options, label: 'lesson batch' }) : null;
	return { result, skipped };
}

// Written aside, fsynced and linked into place, so an interrupted write never leaves a truncated file under the
// final name, and an existing file is never replaced.
async function writeNewFile(path, text) {
	const partial = `${path}.${process.pid}.partial`;
	let handle;
	try {
		handle = await open(partial, 'wx', 0o600);
		await handle.writeFile(text);
		await handle.sync();
		await handle.close();
		handle = null;
		await link(partial, path);
	} finally {
		await handle?.close().catch(() => {});
		await unlink(partial).catch(() => {});
	}
}

const OPTIONS = {
	flair: { type: 'string' },
	'from-jsonl': { type: 'string' },
	snapshot: { type: 'string' },
	'principal-map': { type: 'string' },
	target: { type: 'string' },
	'batch-size': { type: 'string', default: String(MAX_BATCH_SIZE) },
	'max-content-chars': { type: 'string', default: String(DEFAULT_MAX_CONTENT_CHARS) },
	'dry-run': { type: 'boolean', default: false },
	classify: { type: 'boolean', default: false },
	report: { type: 'string' },
	'org-map': { type: 'string' },
	lessons: { type: 'boolean', default: false },
	classifier: { type: 'string' },
	'classifier-model': { type: 'string' },
	concurrency: { type: 'string' },
	decisions: { type: 'string' },
	help: { type: 'boolean', default: false },
};
const CLASSIFY_ONLY = ['report', 'org-map', 'classifier', 'classifier-model', 'concurrency'];

const USAGE = `Usage: node scripts/import-flair.mjs (--flair <url> [--snapshot <file>] | --from-jsonl <file>)
       --principal-map <file> [--batch-size <1-${MAX_BATCH_SIZE}>] [--max-content-chars <1-${MAX_CONTENT_CHARS_LIMIT}>]
       and one of:
       (--dry-run | --target <url>)                       import; shared rows become global
       --classify --report <file> [--org-map <file>] [--lessons] [--classifier claude|anthropic]
         [--classifier-model <id>] [--concurrency <1-${MAX_CONCURRENCY}>]  propose customer scopes; writes the report only
       --decisions <file> (--dry-run | --target <url>)    import with a reviewed report applied

Environment: FLAIR_ADMIN_USER (default admin), FLAIR_ADMIN_PASS for --flair;
             AGENT_MEMORY_USER, AGENT_MEMORY_PASS (a super_user) for --target;
             ANTHROPIC_API_KEY for --classifier anthropic.
`;

function fileExists(path) {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function readJsonFile(path, option) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		throw new Error(`cannot read ${option}: ${error.code ?? 'invalid JSON'}`);
	}
}

async function loadBackend(name, model, env) {
	const { createModelBackend } = await import('./lib/model-backend.mjs');
	// Above the shared default of low: a missed detection publishes customer detail to every global reader.
	return createModelBackend(name, { model, env, effort: 'medium' });
}

function progress(stderr, stage) {
	return (done, total) => {
		if (done === total || done % 25 === 0) stderr.write(`${stage}: ${done}/${total}\n`);
	};
}

export async function run(argv, env, { stdout = process.stdout, stderr = process.stderr, backend } = {}) {
	let mappedSummary;
	let sourceResult;
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) {
			stdout.write(USAGE);
			return 0;
		}
		// An unset shell variable passes "", which must not read as an absent --decisions and import everything as global.
		const empty = Object.keys(values).find((name) => values[name] === '');
		if (empty) throw new UsageError(`--${empty} needs a value`);
		if (Boolean(values.flair) === Boolean(values['from-jsonl'])) {
			throw new UsageError('pass exactly one of --flair or --from-jsonl');
		}
		if (values.snapshot && !values.flair) throw new UsageError('--snapshot applies only to --flair');
		if (!values['principal-map']) throw new UsageError('--principal-map is required');
		if (values.classify && values.decisions !== undefined)
			throw new UsageError('pass at most one of --classify or --decisions');
		if (values.classify) {
			if (!values.report) throw new UsageError('--classify requires --report <file>');
			if (values.target) {
				throw new UsageError('--classify only writes the report; apply it with --decisions and --target');
			}
		} else {
			const misplaced = CLASSIFY_ONLY.find((name) => values[name] !== undefined) ?? (values.lessons && 'lessons');
			if (misplaced) throw new UsageError(`--${misplaced} applies only to --classify`);
			if (!values['dry-run'] && !values.target) throw new UsageError('pass --target, or --dry-run to write nothing');
		}
		const classifier = values.classifier ?? 'claude';
		if (!CLASSIFIERS.has(classifier)) throw new UsageError('--classifier must be claude or anthropic');
		const concurrency = Number(values.concurrency ?? DEFAULT_CONCURRENCY);
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
			throw new UsageError(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
		}
		const batchSize = Number(values['batch-size']);
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
			throw new UsageError(`--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
		}
		const maxContentChars = Number(values['max-content-chars']);
		if (!Number.isInteger(maxContentChars) || maxContentChars < 1 || maxContentChars > MAX_CONTENT_CHARS_LIMIT) {
			throw new UsageError(`--max-content-chars must be an integer from 1 to ${MAX_CONTENT_CHARS_LIMIT}`);
		}
		const target = values['dry-run'] || values.classify ? null : assertSafeUrl(values.target, '--target');
		const targetAuthorization = target && basicAuth(env, 'AGENT_MEMORY_USER', 'AGENT_MEMORY_PASS');
		if (values.classify) {
			if (await fileExists(values.report)) {
				throw new Error('--report names an existing file, and a report is never overwritten (EEXIST)');
			}
			await access(dirname(resolve(values.report)), constants.W_OK | constants.X_OK).catch((error) => {
				throw new Error(`cannot write --report: ${error.code ?? 'unwritable directory'}`);
			});
		}

		const principalMap = parsePrincipalMap(await readJsonFile(values['principal-map'], '--principal-map'));
		const orgMap = values['org-map'] ? parseOrgMap(await readJsonFile(values['org-map'], '--org-map')) : new Map();
		const decisionsJson = values.decisions !== undefined && (await readJsonFile(values.decisions, '--decisions'));

		let flairRows;
		if (values.flair) {
			flairRows = await readFlairLive(
				assertSafeUrl(values.flair, '--flair'),
				basicAuth(env, 'FLAIR_ADMIN_USER', 'FLAIR_ADMIN_PASS', 'admin'),
			);
			if (values.snapshot) {
				await writeNewFile(values.snapshot, flairRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
				stderr.write(`snapshot: ${flairRows.length} Flair memories written to ${values.snapshot}\n`);
			}
		} else {
			let text;
			try {
				text = await readFile(values['from-jsonl'], 'utf8');
			} catch (error) {
				throw new Error(`cannot read --from-jsonl: ${error.code ?? error.message}`);
			}
			flairRows = parseJsonl(text);
		}

		const mapOptions = { maxContentChars };
		if (values.classify) {
			const candidates = classificationCandidates(flairRows, principalMap, mapOptions);
			const classifierBackend = backend ?? (await loadBackend(classifier, values['classifier-model'], env));
			let entries = await classifyCandidates(candidates, {
				backend: classifierBackend,
				orgMap,
				concurrency,
				onProgress: progress(stderr, 'classified'),
			});
			if (entries.length > 0 && entries.every((entry) => entry.failure === 'classifier_error')) {
				const codes = [...new Set(entries.map((entry) => entry.errorCode))].join(', ');
				throw new Error(`the classifier failed on every row (${codes}); check the backend. No report was written`);
			}
			const scopeOverrides = new Map(entries.map((entry) => [entry.flairId, entry.scopes]));
			const { rows, summary } = mapFlairMemories(flairRows, principalMap, { ...mapOptions, scopeOverrides });
			const statusById = new Map(rows.map((row) => [row.id, row.status]));
			if (values.lessons) {
				entries = await draftLessons(entries, {
					backend: classifierBackend,
					orgMap,
					concurrency,
					statusById,
					maxContentChars,
					now: Date.now(),
					onProgress: progress(stderr, 'lessons'),
				});
			}
			const report = buildReport(entries, { source: 'flair', classifier: classifierBackend.name, statusById });
			await writeNewFile(values.report, JSON.stringify(report, null, '\t') + '\n');
			stdout.write(
				JSON.stringify(
					{ dryRun: true, summary, classification: reportSummary(report), report: values.report },
					null,
					'\t',
				) + '\n',
			);
			return 0;
		}

		let rows;
		let summary;
		let lessonRows = null;
		const inactiveLessons = [];
		if (values.decisions !== undefined) {
			const candidates = classificationCandidates(flairRows, principalMap, mapOptions);
			const decisions = readDecisions(decisionsJson, candidates, { maxContentChars });
			const scopeOverrides = new Map(
				candidates.map((candidate) => [candidate.flairId, decisions.get(candidate.id).scopes]),
			);
			({ rows, summary } = mapFlairMemories(flairRows, principalMap, { ...mapOptions, scopeOverrides }));
			lessonRows = [];
			for (const row of rows) {
				const lesson = decisions.get(row.id)?.lesson;
				if (!lesson) continue;
				const built = lessonRow(row, lesson);
				if (row.status === 'active') lessonRows.push(built);
				else inactiveLessons.push({ id: built.id, source: row.id, reason: 'source_not_active' });
			}
		} else {
			({ rows, summary } = mapFlairMemories(flairRows, principalMap, mapOptions));
		}
		mappedSummary = summary;
		const lessonCount = lessonRows && { lessons: { toImport: lessonRows.length, skipped: inactiveLessons } };
		if (values['dry-run']) {
			stdout.write(JSON.stringify({ dryRun: true, summary, ...lessonCount }, null, '\t') + '\n');
			return 0;
		}
		const options = { target, authorization: targetAuthorization, batchSize, stderr };
		sourceResult = await postBatches(rows, options);
		const output = { dryRun: false, summary, result: sourceResult };
		if (lessonRows) output.lessons = await importLessons(lessonRows, inactiveLessons, sourceResult, options);
		stdout.write(JSON.stringify(output, null, '\t') + '\n');
		return 0;
	} catch (error) {
		if (mappedSummary && (error.partialResult || sourceResult)) {
			const output = {
				dryRun: false,
				partial: true,
				summary: mappedSummary,
				result: sourceResult ?? error.partialResult,
			};
			if (sourceResult) output.lessons = { result: error.partialResult ?? null };
			stdout.write(JSON.stringify(output, null, '\t') + '\n');
		}
		const cause = error.cause?.code ?? error.code;
		const suffix = cause && !error.message.includes(cause) ? ` (${cause})` : '';
		stderr.write(`import-flair: ${error.message}${suffix}\n`);
		if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
			stderr.write(USAGE);
			return 2;
		}
		return 1;
	}
}

function isEntryPoint() {
	try {
		return realpathSync(process.argv[1]) === import.meta.filename;
	} catch {
		return false;
	}
}

if (isEntryPoint()) process.exitCode = await run(process.argv.slice(2), process.env);
