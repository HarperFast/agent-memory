import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test } from 'harper';
import { importMemories } from '../dist/import.js';
import { memoryTable } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import {
	DEFAULT_MAX_CONTENT_CHARS,
	MAX_BATCH_SIZE,
	mapFlairMemories,
	memoryIdFor,
	parseJsonl,
	parsePrincipalMap,
	run,
} from '../scripts/import-flair.mjs';

const FIXTURE = new URL('./fixtures/flair-memories.jsonl', import.meta.url).pathname;
const PRINCIPAL_MAP = new URL('./fixtures/principal-map.json', import.meta.url).pathname;
const flairRows = parseJsonl(await readFile(FIXTURE, 'utf8'));
const principalMap = parsePrincipalMap(JSON.parse(await readFile(PRINCIPAL_MAP, 'utf8')));

function idOf(flairId) {
	return createHash('sha256').update(`flair:${flairId}`).digest('hex').slice(0, 32);
}

const flairById = new Map(flairRows.map((row) => [idOf(row.id), row.id]));

function mapped() {
	const { rows, summary } = mapFlairMemories(flairRows, principalMap);
	const byKey = new Map(rows.map((row) => [flairById.get(row.id), row]));
	return { rows, summary, byKey };
}

function capture() {
	let text = '';
	return {
		write: (chunk) => (text += chunk),
		get text() {
			return text;
		},
	};
}

async function cli(argv, env = {}) {
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, env, { stdout, stderr });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

async function stubServer(handler) {
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const entry = { method: request.method, url: request.url, headers: request.headers, body };
		requests.push(entry);
		const { status = 200, json, raw } = await handler(entry, requests.length);
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(raw ?? JSON.stringify(json));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function importHandler(resultFor = () => 'created') {
	return ({ body }) => {
		const { rows } = JSON.parse(body);
		return { json: { results: rows.map((row) => ({ id: row.id, result: resultFor(row) })) } };
	};
}

const TARGET_ENV = { AGENT_MEMORY_USER: 'importer', AGENT_MEMORY_PASS: 'target-secret' };

describe('mapFlairMemories', () => {
	it('maps Flair visibility to scopes: private is owner-only, anything else is global', () => {
		const { byKey, summary } = mapped();
		assert.deepEqual(byKey.get('m01').scopes, ['user:ann']);
		assert.deepEqual(byKey.get('m02').scopes, ['global']);
		assert.deepEqual(byKey.get('m03').scopes, ['global'], 'absent visibility is readable by every Flair agent');
		assert.deepEqual(byKey.get('m10').scopes, ['global'], 'legacy values read as non-private in Flair');
		assert.deepEqual(summary.unknownVisibility, { office: 1 });
		assert.deepEqual(summary.byScope, { 'user:ann': 3, 'user:bob': 1, global: 7 });
	});

	it('derives every row id from sha256("flair:" + flairId)[:32], deterministically', () => {
		const first = mapFlairMemories(flairRows, principalMap);
		const second = mapFlairMemories(structuredClone(flairRows), principalMap);
		assert.deepEqual(second, first);
		const row = first.rows.find((candidate) => candidate.id === memoryIdFor('m01'));
		assert.equal(row.id, idOf('m01'));
		assert.equal(row.ownerId, 'ann');
		assert.equal(new Set(first.rows.map((candidate) => candidate.id)).size, first.rows.length);
	});

	it('rewrites supersedes to target ids and derives status and supersededBy', () => {
		const { byKey, summary } = mapped();
		assert.deepEqual(byKey.get('m02').supersedes, [idOf('m01')]);
		assert.deepEqual(byKey.get('m03').supersedes, [idOf('m02')], 'cross-owner links resolve');
		assert.equal(byKey.get('m01').status, 'superseded');
		assert.equal(byKey.get('m01').supersededBy, idOf('m02'));
		assert.equal(byKey.get('m02').status, 'superseded');
		assert.equal(byKey.get('m02').supersededBy, idOf('m03'));
		assert.equal(byKey.get('m03').status, 'active');
		assert.equal(byKey.get('m03').supersededBy, undefined);
		assert.equal(byKey.get('m01').validUntil, '2026-01-02T00:00:00.000Z');
		assert.equal(summary.supersedes.resolved, 3);
		assert.deepEqual(summary.byStatus, { active: 8, superseded: 2, withdrawn: 1 });
	});

	it('drops dangling links and reports each with its reason', () => {
		const { rows, byKey, summary } = mapped();
		for (const flairId of ['m04', 'm06', 'm11', 'm12', 'm13']) {
			assert.equal(byKey.get(flairId).supersedes, undefined, `${flairId} carries no dangling link`);
			assert.equal(byKey.get(flairId).status, 'active');
		}
		assert.deepEqual(summary.supersedes.unresolved, [
			{ from: 'm04', to: 'gone', reason: 'missing' },
			{ from: 'm06', to: 'm05', reason: 'skipped' },
			{ from: 'm13', to: 'm10', reason: 'narrowing' },
			{ from: 'm11', to: 'm12', reason: 'cycle' },
			{ from: 'm12', to: 'm11', reason: 'cycle' },
		]);
		const sentIds = new Set(rows.map((row) => row.id));
		for (const row of rows) {
			for (const id of row.supersedes ?? []) assert.ok(sentIds.has(id));
			if (row.supersededBy) assert.ok(sentIds.has(row.supersededBy));
		}
	});

	it('skips memories of unmapped agents and reports them by agent', () => {
		const { rows, summary } = mapped();
		assert.deepEqual(summary.skipped.unmappedAgents, { 'agent-ghost': 1 });
		assert.ok(!rows.some((row) => row.id === memoryIdFor('m05')));
		assert.deepEqual(summary.byOwner, { ann: 8, bob: 3 });
		assert.equal(summary.read, 13);
		assert.equal(summary.toImport, 11);
	});

	it('skips ephemeral memories, which carry an expiry the target cannot honor', () => {
		const { rows, summary } = mapped();
		assert.equal(summary.skipped.ephemeral, 1);
		assert.ok(!rows.some((row) => row.id === memoryIdFor('m07')));
	});

	it('maps archived to withdrawn, and a withdrawn successor leaves its predecessor active', () => {
		const { byKey } = mapped();
		assert.equal(byKey.get('m08').status, 'withdrawn');
		assert.equal(byKey.get('m08').withdrawnAt, '2026-02-01T00:00:00.000Z');
		assert.equal(byKey.get('m08').withdrawnReason, 'archived in Flair');
		assert.deepEqual(byKey.get('m08').supersedes, [idOf('m09')]);
		assert.equal(byKey.get('m09').status, 'active');
		assert.equal(byKey.get('m09').supersededBy, undefined);
	});

	it('drops a link whose replacement some reader of the old memory cannot read', () => {
		assert.equal(mapped().byKey.get('m10').status, 'active', 'global m10 stays visible; private m13 cannot replace it');
		const pair = (old, replacement) => [
			{ id: 'old', content: 'c', createdAt: '2026-01-01T00:00:00Z', ...old },
			{ id: 'new', content: 'c', createdAt: '2026-01-02T00:00:00Z', supersedes: 'old', ...replacement },
		];
		const outcome = (old, replacement) => {
			const { rows, summary } = mapFlairMemories(pair(old, replacement), principalMap);
			return [rows.find((row) => row.id === memoryIdFor('old')).status, summary.supersedes.unresolved];
		};
		const ann = { agentId: 'agent-ann' };
		const bob = { agentId: 'agent-bob' };
		assert.deepEqual(outcome({ ...ann, visibility: 'private' }, { ...ann, visibility: 'private' }), ['superseded', []]);
		assert.deepEqual(outcome({ ...ann, visibility: 'private' }, { ...ann, visibility: 'shared' }), ['superseded', []]);
		assert.deepEqual(outcome({ ...ann, visibility: 'private' }, { ...bob, visibility: 'shared' }), ['superseded', []]);
		const narrowing = [{ from: 'new', to: 'old', reason: 'narrowing' }];
		assert.deepEqual(outcome({ ...ann, visibility: 'shared' }, { ...ann, visibility: 'private' }), [
			'active',
			narrowing,
		]);
		assert.deepEqual(outcome({ ...ann, visibility: 'private' }, { ...bob, visibility: 'private' }), [
			'active',
			narrowing,
		]);
	});

	it('never marks an archived memory superseded, even when a live memory supersedes it', () => {
		const { rows } = mapFlairMemories(
			[
				{ id: 'old', agentId: 'agent-ann', content: 'c', createdAt: '2026-01-01T00:00:00Z', archived: true },
				{ id: 'new', agentId: 'agent-ann', content: 'c', createdAt: '2026-01-02T00:00:00Z', supersedes: 'old' },
			],
			principalMap,
		);
		const [replacement, archived] = rows;
		assert.equal(archived.status, 'withdrawn');
		assert.equal(archived.supersededBy, undefined);
		assert.deepEqual(replacement.supersedes, [archived.id]);
		assert.equal(replacement.status, 'active');
	});

	it('counts ids that collide with Object.prototype names', () => {
		const rows = ['__proto__', 'toString', 'constructor'].map((agentId, index) => ({
			id: `p${index}`,
			agentId,
			content: 'c',
			createdAt: '2026-01-01T00:00:00Z',
		}));
		rows.push({
			id: 'v',
			agentId: 'agent-ann',
			content: 'c',
			createdAt: '2026-01-01T00:00:00Z',
			visibility: '__proto__',
		});
		const { summary } = mapFlairMemories(rows, principalMap);
		assert.deepEqual(JSON.parse(JSON.stringify(summary.skipped.unmappedAgents)), {
			['__proto__']: 1,
			toString: 1,
			constructor: 1,
		});
		assert.equal(JSON.stringify(summary.unknownVisibility), '{"__proto__":1}');
	});

	it('orders every successor before the row it supersedes', () => {
		const { rows } = mapped();
		const position = new Map(rows.map((row, index) => [row.id, index]));
		for (const row of rows) {
			for (const predecessor of row.supersedes ?? []) assert.ok(position.get(row.id) < position.get(predecessor));
		}
	});

	it('orders a long chain without recursion', () => {
		const chain = Array.from({ length: 20_000 }, (_, index) => ({
			id: `c${index}`,
			agentId: 'agent-ann',
			content: 'x',
			createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
			supersedes: index ? `c${index - 1}` : undefined,
		}));
		const { rows, summary } = mapFlairMemories(chain, principalMap);
		assert.equal(rows[0].id, memoryIdFor('c19999'));
		assert.equal(rows.at(-1).id, memoryIdFor('c0'));
		assert.equal(summary.byStatus.active, 1);
	});

	it('skips rows that fail server content or tag limits and resolves links to them as skipped', () => {
		const base = { agentId: 'agent-ann', createdAt: '2026-01-01T00:00:00Z' };
		const input = [
			{ ...base, id: 'blank', content: '   ' },
			{ ...base, id: 'overlong', content: 'x'.repeat(11) },
			{ ...base, id: 'many-tags', content: 'ok', tags: Array.from({ length: 21 }, (_, index) => `t${index}`) },
			{ ...base, id: 'empty-tag', content: 'ok', tags: ['valid', ' '] },
			{ ...base, id: 'long-tag', content: 'ok', tags: ['y'.repeat(65)] },
			{ ...base, id: 'valid', content: 'ok', createdAt: '2026-01-02T00:00:00Z', supersedes: 'blank' },
		];
		const { rows, summary } = mapFlairMemories(input, principalMap, { maxContentChars: 10 });
		assert.deepEqual(
			rows.map((row) => row.id),
			[memoryIdFor('valid')],
		);
		assert.equal(rows[0].supersedes, undefined);
		assert.deepEqual(summary.skipped.invalid, [
			{ id: 'blank', reason: 'content_required' },
			{ id: 'empty-tag', reason: 'invalid_tags' },
			{ id: 'long-tag', reason: 'tags_too_long' },
			{ id: 'many-tags', reason: 'tags_too_many' },
			{ id: 'overlong', reason: 'content_too_long' },
		]);
		assert.deepEqual(summary.supersedes.unresolved, [{ from: 'valid', to: 'blank', reason: 'skipped' }]);
	});

	it('breaks createdAt ties by target id to match the server newest-superseder rule', async () => {
		// Flair order: "c" < "d", but sha256("flair:c") = "fbea..." > sha256("flair:d") = "44ed...".
		assert.ok(memoryIdFor('c') > memoryIdFor('d'));
		const tied = [
			{ id: 'old', agentId: 'agent-ann', content: 'old', createdAt: '2026-01-01T00:00:00Z' },
			{ id: 'c', agentId: 'agent-ann', content: 'c', createdAt: '2026-01-02T00:00:00Z', supersedes: 'old' },
			{ id: 'd', agentId: 'agent-ann', content: 'd', createdAt: '2026-01-02T00:00:00Z', supersedes: 'old' },
		];
		const { rows } = mapFlairMemories(tied, principalMap);
		const oldRow = rows.find((row) => row.id === memoryIdFor('old'));
		assert.equal(oldRow.supersededBy, memoryIdFor('c'));

		__test.reset();
		applySettings(parseSettings({}));
		const root = createPrincipal({ id: 'root', superUser: true });
		await importMemories({ rows }, root, {});
		const stored = await memoryTable().get(memoryIdFor('old'), {});
		assert.equal(stored.supersededBy, oldRow.supersededBy);
	});

	it('sends only allowlisted fields accepted by importMemories, never embeddings or Flair bookkeeping', async () => {
		const allowed = new Set([
			'id',
			'ownerId',
			'content',
			'scopes',
			'status',
			'createdAt',
			'tags',
			'supersedes',
			'supersededBy',
			'validUntil',
			'withdrawnAt',
			'withdrawnReason',
		]);
		const { rows, byKey } = mapped();
		for (const row of rows) for (const field of Object.keys(row)) assert.ok(allowed.has(field), field);
		assert.deepEqual(byKey.get('m01').tags, ['deploy']);
		assert.equal(byKey.get('m02').durability, undefined);
		assert.equal(byKey.get('m01').createdAt, '2026-01-01T00:00:00.000Z');

		__test.reset();
		applySettings(parseSettings({}));
		const root = createPrincipal({ id: 'root', superUser: true });
		const Memory = memoryTable();
		for (let start = 0; start < rows.length; start += 4) {
			const batch = rows.slice(start, start + 4);
			const first = await importMemories({ rows: batch }, root, {});
			assert.deepEqual(
				first.results,
				batch.map((row) => ({ id: row.id, result: 'created' })),
			);
			for (const committed of rows.slice(0, start + batch.length)) {
				const stored = await Memory.get(committed.id, {});
				if (stored.status === 'superseded') {
					assert.ok(await Memory.get(stored.supersededBy, {}), 'every superseded row has its replacement committed');
				}
			}
		}
		for (const row of rows) {
			const stored = await Memory.get(row.id, {});
			assert.equal(stored.status, row.status);
			assert.equal(stored.supersededBy, row.supersededBy ?? null);
		}
		const second = await importMemories({ rows }, root, {});
		assert.deepEqual(
			second.results,
			rows.map((row) => ({ id: row.id, result: 'unchanged' })),
		);
	});

	it('refuses malformed input before anything is mapped', () => {
		const base = { id: 'x', agentId: 'agent-ann', content: 'c', createdAt: '2026-01-01T00:00:00Z' };
		assert.throws(() => mapFlairMemories([{ ...base, createdAt: 'garbage' }], principalMap), /createdAt/);
		assert.throws(() => mapFlairMemories([{ ...base, tags: 'deploy' }], principalMap), /tags/);
		assert.throws(() => mapFlairMemories([{ ...base, validTo: 'soon' }], principalMap), /validTo/);
		assert.throws(() => mapFlairMemories([{ ...base, archived: 'yes' }], principalMap), /archived/);
		assert.throws(() => mapFlairMemories([base, base], principalMap), /more than once/);
		assert.throws(() => mapFlairMemories([{ ...base, id: undefined }], principalMap), /#1 has no string id/);
		assert.throws(() => mapFlairMemories([base], principalMap, { maxContentChars: 0 }), /maxContentChars/);
		assert.throws(() => parseJsonl('{"id":"a"}\n{nope\n'), /line 2/);
	});

	it('refuses principal-map entries that are not valid Harper principal ids', () => {
		assert.throws(() => parsePrincipalMap({ a: 'has:colon' }), /"a"/);
		assert.throws(() => parsePrincipalMap({ a: 'has space' }), /"a"/);
		assert.throws(() => parsePrincipalMap({ a: 'x'.repeat(123) }), /"a"/);
		assert.throws(() => parsePrincipalMap({ a: 7 }), /"a"/);
		assert.throws(() => parsePrincipalMap(['ann']), /JSON object/);
	});
});

describe('import-flair CLI', () => {
	let directory;
	before(async () => {
		directory = await mkdtemp(join(tmpdir(), 'import-flair-'));
	});
	after(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it('--dry-run prints counts and ids only, and contacts no target', async () => {
		const target = await stubServer(importHandler());
		try {
			const result = await cli(['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--dry-run']);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(target.requests.length, 0);
			assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
			const { dryRun, summary } = JSON.parse(result.stdout);
			assert.equal(dryRun, true);
			assert.deepEqual(summary, mapped().summary);
		} finally {
			target.close();
		}
	});

	it('posts ordered batches with target credentials from the environment and tallies results', async () => {
		const target = await stubServer(importHandler((row) => (row.id === memoryIdFor('m04') ? 'conflict' : 'created')));
		try {
			const result = await cli(
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--target', `${target.url}/`, '--batch-size', '4'],
				TARGET_ENV,
			);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(target.requests.length, 3);
			const expectedAuth = `Basic ${Buffer.from('importer:target-secret').toString('base64')}`;
			for (const request of target.requests) {
				assert.equal(request.method, 'POST');
				assert.equal(request.url, '/Memory/import');
				assert.equal(request.headers.authorization, expectedAuth);
				assert.equal(request.headers['content-type'], 'application/json');
			}
			const sent = target.requests.flatMap((request) => JSON.parse(request.body).rows);
			assert.deepEqual(sent, mapped().rows);
			assert.deepEqual(
				target.requests.map((request) => JSON.parse(request.body).rows.length),
				[4, 4, 3],
			);
			const { result: tally } = JSON.parse(result.stdout);
			assert.deepEqual(tally, {
				created: 10,
				unchanged: 0,
				conflict: 1,
				conflicts: [{ id: idOf('m04') }],
				dependsOnConflict: [],
			});
		} finally {
			target.close();
		}
	});

	it('reads Flair live with admin credentials from the environment and can save a snapshot', async () => {
		const flair = await stubServer(() => ({ json: flairRows }));
		const target = await stubServer(importHandler());
		const snapshot = join(directory, 'snapshot.jsonl');
		try {
			const result = await cli(
				['--flair', flair.url, '--snapshot', snapshot, '--principal-map', PRINCIPAL_MAP, '--target', target.url],
				{ ...TARGET_ENV, FLAIR_ADMIN_PASS: 'flair-secret' },
			);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(flair.requests.length, 1);
			const [read] = flair.requests;
			assert.equal(read.method, 'GET');
			assert.match(decodeURIComponent(read.url), /^\/Memory\/\?select\(id,agentId,content,[^)]*\)$/);
			assert.doesNotMatch(read.url, /embedding/);
			assert.equal(read.headers.authorization, `Basic ${Buffer.from('admin:flair-secret').toString('base64')}`);
			assert.deepEqual(
				target.requests.flatMap((request) => JSON.parse(request.body).rows),
				mapped().rows,
			);
			assert.deepEqual(parseJsonl(await readFile(snapshot, 'utf8')), flairRows);
			assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
			const again = await cli(
				['--flair', flair.url, '--snapshot', snapshot, '--principal-map', PRINCIPAL_MAP, '--dry-run'],
				{
					FLAIR_ADMIN_PASS: 'flair-secret',
				},
			);
			assert.equal(again.code, 1, 'an existing snapshot is never overwritten');
			assert.match(again.stderr, /EEXIST/);
			assert.deepEqual(
				(await readdir(directory)).filter((name) => name.includes('partial')),
				[],
				'no partial snapshot is left behind',
			);
		} finally {
			flair.close();
			target.close();
		}
	});

	it('stops on a failed batch and reports status, code and row id without the response message', async () => {
		const target = await stubServer((_request, count) =>
			count === 2
				? { status: 400, json: { error: 'SECRET-echo', code: 'invalid_id', index: 1 } }
				: importHandler()(_request),
		);
		try {
			const result = await cli(
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--target', target.url, '--batch-size', '4'],
				TARGET_ENV,
			);
			assert.equal(result.code, 1);
			assert.equal(target.requests.length, 2);
			const secondBatch = JSON.parse(target.requests[1].body).rows;
			assert.match(result.stderr, /batch 2\/3 failed: HTTP 400, code invalid_id, row 1 \([0-9a-f]{32}\)/);
			assert.ok(result.stderr.includes(secondBatch[1].id));
			assert.doesNotMatch(result.stderr, /SECRET/);
			const partial = JSON.parse(result.stdout);
			assert.equal(partial.partial, true);
			assert.equal(partial.result.created, 4);
		} finally {
			target.close();
		}
	});

	it('lists created or unchanged rows whose replacement came back as a conflict', async () => {
		for (const [batchSize, nonConflictResult] of [
			['4', 'created'],
			['100', 'unchanged'],
		]) {
			const target = await stubServer(
				importHandler((row) => (row.id === memoryIdFor('m03') ? 'conflict' : nonConflictResult)),
			);
			try {
				const result = await cli(
					[
						'--from-jsonl',
						FIXTURE,
						'--principal-map',
						PRINCIPAL_MAP,
						'--target',
						target.url,
						'--batch-size',
						batchSize,
					],
					TARGET_ENV,
				);
				assert.equal(result.code, 0, result.stderr);
				assert.deepEqual(JSON.parse(result.stdout).result.dependsOnConflict, [
					{ id: idOf('m02'), supersededBy: idOf('m03') },
				]);
			} finally {
				target.close();
			}
		}
	});

	it('never prints memory content from a malformed Flair response or an unrecognized error code', async () => {
		const flair = await stubServer(() => ({ raw: '[{"content":"SECRET-truncated' }));
		try {
			const result = await cli(['--flair', flair.url, '--principal-map', PRINCIPAL_MAP, '--dry-run'], {
				FLAIR_ADMIN_PASS: 'flair-secret',
			});
			assert.equal(result.code, 1);
			assert.match(result.stderr, /not a JSON array/);
			assert.doesNotMatch(result.stderr, /SECRET/);
		} finally {
			flair.close();
		}
		const target = await stubServer(() => ({ status: 400, json: { code: 'SECRET content here', index: 0 } }));
		try {
			const result = await cli(
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--target', target.url],
				TARGET_ENV,
			);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /HTTP 400, row 0 \([0-9a-f]{32}\)/);
			assert.doesNotMatch(result.stderr, /SECRET/);
		} finally {
			target.close();
		}
	});

	it('refuses a 2xx response that does not carry one result per row', async () => {
		const target = await stubServer(() => ({ json: { results: [] } }));
		try {
			const result = await cli(
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--target', target.url],
				TARGET_ENV,
			);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /one result per row/);
		} finally {
			target.close();
		}
	});

	it('takes credentials only from the environment and refuses unsafe URLs', async () => {
		const missing = await cli([
			'--from-jsonl',
			FIXTURE,
			'--principal-map',
			PRINCIPAL_MAP,
			'--target',
			'https://memory.example',
		]);
		assert.equal(missing.code, 2);
		assert.match(missing.stderr, /AGENT_MEMORY_USER and AGENT_MEMORY_PASS/);

		const noFlairPass = await cli(['--flair', 'https://flair.example', '--principal-map', PRINCIPAL_MAP, '--dry-run']);
		assert.equal(noFlairPass.code, 2);
		assert.match(noFlairPass.stderr, /FLAIR_ADMIN_PASS/);

		for (const [url, pattern] of [
			['https://admin:pw@memory.example', /must not embed credentials/],
			['http://memory.example', /must use https/],
			['https://memory.example/?x=1', /query or fragment/],
		]) {
			const result = await cli(
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--target', url],
				TARGET_ENV,
			);
			assert.equal(result.code, 2, url);
			assert.match(result.stderr, pattern);
		}
	});

	it('validates arguments before reading anything', async () => {
		for (const [argv, pattern] of [
			[['--principal-map', PRINCIPAL_MAP, '--dry-run'], /exactly one of --flair or --from-jsonl/],
			[['--from-jsonl', FIXTURE, '--dry-run'], /--principal-map is required/],
			[['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP], /--target, or --dry-run/],
			[
				['--from-jsonl', FIXTURE, '--snapshot', 'x', '--principal-map', PRINCIPAL_MAP, '--dry-run'],
				/--snapshot applies only/,
			],
			[
				[
					'--from-jsonl',
					FIXTURE,
					'--principal-map',
					PRINCIPAL_MAP,
					'--dry-run',
					'--batch-size',
					String(MAX_BATCH_SIZE + 1),
				],
				/--batch-size/,
			],
			[
				['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP, '--dry-run', '--max-content-chars', '100001'],
				/--max-content-chars/,
			],
			[['--bogus'], /bogus/],
		]) {
			const result = await cli(argv);
			assert.equal(result.code, 2, argv.join(' '));
			assert.match(result.stderr, pattern);
		}
	});

	it('reports an unreadable input file by error code', async () => {
		const badMap = join(directory, 'bad-map.json');
		await writeFile(badMap, '{ not json');
		const result = await cli(['--from-jsonl', FIXTURE, '--principal-map', badMap, '--dry-run']);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /cannot read --principal-map: invalid JSON/);
		const missing = await cli([
			'--from-jsonl',
			join(directory, 'absent.jsonl'),
			'--principal-map',
			PRINCIPAL_MAP,
			'--dry-run',
		]);
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /ENOENT/);
	});
});
