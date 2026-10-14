#!/usr/bin/env node
// Import memories from a Flair instance (tpsdev-ai/flair) into @harperfast/agent-memory through
// POST /Memory/import. Usage and rules: README.md "Import" and DESIGN.md "Import".

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 120_000;
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
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);

class UsageError extends Error {}

export function importKey(flairId) {
	return `import:flair:${flairId}`;
}

// DESIGN.md "Lifecycle": the create id formula; the import endpoint recomputes and rejects a mismatch.
export function memoryIdFor(ownerId, idempotencyKey) {
	return createHash('sha256').update(`memory:${ownerId}:${idempotencyKey}`).digest('hex').slice(0, 32);
}

// DESIGN.md "Identity": principal ids must fit a 128-character `user:<id>` scope label.
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

function compareByCreated(a, b) {
	return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function increment(counts, key) {
	counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Maps raw Flair Memory rows to import rows, ordered so every successor precedes the rows it supersedes.
 * Pure: the same input and principal map always produce the same rows and summary.
 */
export function mapFlairMemories(flairRows, principalMap) {
	const byFlairId = new Map();
	flairRows.forEach((row, index) => {
		validateFlairRow(row, index);
		if (byFlairId.has(row.id)) throw new Error(`Flair memory ${JSON.stringify(row.id)} appears more than once`);
		byFlairId.set(row.id, row);
	});

	const summary = {
		source: 'flair',
		read: flairRows.length,
		toImport: 0,
		skipped: { unmappedAgents: {}, ephemeral: 0 },
		byOwner: {},
		byScope: {},
		byStatus: { active: 0, superseded: 0, withdrawn: 0 },
		unknownVisibility: {},
		supersedes: { resolved: 0, unresolved: [], scopeNarrowing: [] },
	};

	const eligible = new Map();
	for (const row of [...byFlairId.values()].sort(compareByCreated)) {
		const ownerId = principalMap.get(row.agentId);
		if (ownerId === undefined) {
			increment(summary.skipped.unmappedAgents, row.agentId);
			continue;
		}
		// Flair stamps expiresAt only on the ephemeral tier; the target has no expiry, so importing would
		// make self-pruning working state permanent.
		if (row.durability === 'ephemeral' || row.expiresAt != null) {
			summary.skipped.ephemeral++;
			continue;
		}
		const idempotencyKey = importKey(row.id);
		// Flair reads only the literal "private" as owner-only; any other value is readable by every agent.
		const scopes = row.visibility === 'private' ? [`user:${ownerId}`] : ['global'];
		if (row.visibility != null && row.visibility !== 'private' && row.visibility !== 'shared') {
			increment(summary.unknownVisibility, row.visibility);
		}
		eligible.set(row.id, { flair: row, id: memoryIdFor(ownerId, idempotencyKey), idempotencyKey, ownerId, scopes });
	}

	const predecessorOf = new Map();
	for (const entry of eligible.values()) {
		const target = entry.flair.supersedes;
		if (!target) continue;
		const reason =
			target === entry.flair.id
				? 'self'
				: !byFlairId.has(target)
					? 'missing'
					: !eligible.has(target)
						? 'skipped'
						: null;
		if (reason) summary.supersedes.unresolved.push({ from: entry.flair.id, to: target, reason });
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
		summary.supersedes.unresolved.push({ from: flairId, to: predecessorOf.get(flairId), reason: 'cycle' });
		predecessorOf.delete(flairId);
		order.push(flairId);
	}

	const latestLiveSuccessor = new Map();
	for (const flairId of order) {
		const target = predecessorOf.get(flairId);
		if (target === undefined || eligible.get(flairId).flair.archived === true) continue;
		const current = latestLiveSuccessor.get(target);
		if (!current || compareByCreated(byFlairId.get(current), byFlairId.get(flairId)) < 0) {
			latestLiveSuccessor.set(target, flairId);
		}
	}

	const rows = order.map((flairId) => {
		const { flair, id, idempotencyKey, ownerId, scopes } = eligible.get(flairId);
		const successor = latestLiveSuccessor.get(flairId);
		const status = flair.archived === true ? 'withdrawn' : successor ? 'superseded' : 'active';
		const row = { id, idempotencyKey, ownerId, content: flair.content, scopes, status, createdAt: flair.createdAt };
		if (flair.tags?.length) row.tags = flair.tags;
		if (flair.durability != null) row.durability = flair.durability;
		const target = predecessorOf.get(flairId);
		if (target !== undefined) {
			const predecessor = eligible.get(target);
			row.supersedes = [predecessor.id];
			summary.supersedes.resolved++;
			// DESIGN.md read rule: a reader of the predecessor keeps access through a shared label, or as the owner.
			if (predecessor.scopes.some((label) => !scopes.includes(label) && label !== `user:${ownerId}`)) {
				summary.supersedes.scopeNarrowing.push({ from: flairId, to: target });
			}
		}
		if (successor) row.supersededBy = eligible.get(successor).id;
		if (flair.validTo != null) row.validUntil = flair.validTo;
		if (status === 'withdrawn') {
			if (flair.archivedAt != null) row.withdrawnAt = flair.archivedAt;
			row.withdrawnReason = 'archived in Flair';
		}
		increment(summary.byOwner, ownerId);
		for (const label of scopes) increment(summary.byScope, label);
		summary.byStatus[status]++;
		return row;
	});
	summary.toImport = rows.length;
	return { rows, summary };
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

async function readFlairLive(flairBase, authorization) {
	const response = await fetch(`${flairBase}/Memory/?select(${FLAIR_FIELDS.join(',')})`, {
		headers: { Authorization: authorization, Accept: 'application/json' },
		redirect: 'error',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`reading Flair memories failed: HTTP ${response.status}`);
	const rows = await response.json();
	if (!Array.isArray(rows)) throw new Error('reading Flair memories failed: response is not a JSON array');
	return rows;
}

async function errorDetail(response, rows) {
	try {
		const body = await response.json();
		const parts = [];
		if (typeof body?.code === 'string') parts.push(`code ${body.code.slice(0, 80)}`);
		if (Number.isInteger(body?.index) && rows[body.index]) {
			parts.push(`row ${body.index} (${rows[body.index].idempotencyKey})`);
		}
		return parts.length ? `, ${parts.join(', ')}` : '';
	} catch {
		return '';
	}
}

async function postBatches(rows, { target, authorization, batchSize, stderr }) {
	const url = `${target}/Memory/import`;
	const result = { created: 0, unchanged: 0, conflict: 0, conflicts: [] };
	const batchCount = Math.ceil(rows.length / batchSize);
	for (let start = 0, batch = 1; start < rows.length; start += batchSize, batch++) {
		const batchRows = rows.slice(start, start + batchSize);
		const response = await fetch(url, {
			method: 'POST',
			headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ rows: batchRows }),
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(
				`batch ${batch}/${batchCount} failed: HTTP ${response.status}${await errorDetail(response, batchRows)}; earlier batches are committed and a re-run resumes`,
			);
		}
		const body = await response.json().catch(() => null);
		const results = body?.results;
		if (
			!Array.isArray(results) ||
			results.length !== batchRows.length ||
			!results.every((entry, index) => entry?.id === batchRows[index].id && IMPORT_RESULTS.has(entry.result))
		) {
			throw new Error(`batch ${batch}/${batchCount}: response does not carry one result per row in order`);
		}
		results.forEach((entry, index) => {
			result[entry.result]++;
			if (entry.result === 'conflict') {
				result.conflicts.push({ id: entry.id, idempotencyKey: batchRows[index].idempotencyKey });
			}
		});
		stderr.write(`batch ${batch}/${batchCount}: ${batchRows.length} rows\n`);
	}
	return result;
}

const OPTIONS = {
	flair: { type: 'string' },
	'from-jsonl': { type: 'string' },
	snapshot: { type: 'string' },
	'principal-map': { type: 'string' },
	target: { type: 'string' },
	'batch-size': { type: 'string', default: String(MAX_BATCH_SIZE) },
	'dry-run': { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
};

const USAGE = `Usage: node scripts/import-flair.mjs (--flair <url> [--snapshot <file>] | --from-jsonl <file>)
       --principal-map <file> (--dry-run | --target <url>) [--batch-size <1-${MAX_BATCH_SIZE}>]

Environment: FLAIR_ADMIN_USER (default admin), FLAIR_ADMIN_PASS for --flair;
             AGENT_MEMORY_USER, AGENT_MEMORY_PASS (a super_user) for --target.
`;

export async function run(argv, env, { stdout = process.stdout, stderr = process.stderr } = {}) {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) {
			stdout.write(USAGE);
			return 0;
		}
		if (Boolean(values.flair) === Boolean(values['from-jsonl'])) {
			throw new UsageError('pass exactly one of --flair or --from-jsonl');
		}
		if (values.snapshot && !values.flair) throw new UsageError('--snapshot applies only to --flair');
		if (!values['principal-map']) throw new UsageError('--principal-map is required');
		if (!values['dry-run'] && !values.target) throw new UsageError('pass --target, or --dry-run to write nothing');
		const batchSize = Number(values['batch-size']);
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
			throw new UsageError(`--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
		}
		const target = values['dry-run'] ? null : assertSafeUrl(values.target, '--target');
		const targetAuthorization = target && basicAuth(env, 'AGENT_MEMORY_USER', 'AGENT_MEMORY_PASS');

		let principalJson;
		try {
			principalJson = JSON.parse(await readFile(values['principal-map'], 'utf8'));
		} catch (error) {
			throw new Error(`cannot read --principal-map: ${error.code ?? 'invalid JSON'}`);
		}
		const principalMap = parsePrincipalMap(principalJson);

		let flairRows;
		if (values.flair) {
			flairRows = await readFlairLive(
				assertSafeUrl(values.flair, '--flair'),
				basicAuth(env, 'FLAIR_ADMIN_USER', 'FLAIR_ADMIN_PASS', 'admin'),
			);
			if (values.snapshot) {
				const jsonl = flairRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
				await writeFile(values.snapshot, jsonl, { mode: 0o600, flag: 'wx' });
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

		const { rows, summary } = mapFlairMemories(flairRows, principalMap);
		if (values['dry-run']) {
			stdout.write(JSON.stringify({ dryRun: true, summary }, null, '\t') + '\n');
			return 0;
		}
		const result = await postBatches(rows, { target, authorization: targetAuthorization, batchSize, stderr });
		stdout.write(JSON.stringify({ dryRun: false, summary, result }, null, '\t') + '\n');
		return 0;
	} catch (error) {
		const cause = error.cause?.code ?? error.cause?.message;
		stderr.write(`import-flair: ${error.message}${cause ? ` (${cause})` : ''}\n`);
		if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
			stderr.write(USAGE);
			return 2;
		}
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = await run(process.argv.slice(2), process.env);
}
