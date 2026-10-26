import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { differences, run, successorOrder, toImportRow } from '../scripts/copy-memories.mjs';

const FROM_AUTH = 'Basic c291cmNlOnNlY3JldA==';
const TO_AUTH = 'Bearer target-token-value';
const ENV = { AGENT_MEMORY_FROM_AUTHORIZATION: FROM_AUTH, AGENT_MEMORY_TO_AUTHORIZATION: TO_AUTH };
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');

const view = (tag, overrides = {}) => ({
	id: idFor(tag),
	title: null,
	content: `content ${tag}`,
	tags: [],
	scopes: ['global'],
	ownerId: 'alice',
	status: 'active',
	revision: 3,
	evidence: [],
	evidenceMemoryIds: [],
	supersedes: [],
	autoSupersedes: [],
	supersededBy: null,
	needsReview: null,
	confirmed: null,
	contentFlag: null,
	scopeConfirmed: null,
	author: { principalId: 'alice', source: 'mcp' },
	lastEditor: null,
	validUntil: null,
	withdrawnAt: null,
	withdrawnReason: null,
	createdAt: '2025-01-01T00:00:00.000Z',
	updatedAt: '2025-02-01T00:00:00.000Z',
	...overrides,
});

// Two fake instances: each serves its `memories` through the list (honoring the cursor) and records imports.
function fakeInstance() {
	const instance = {
		memories: [],
		imports: [],
		acknowledges: true,
		listStatus: 200,
		requests: [],
		async handle(request, response) {
			let body = '';
			for await (const chunk of request) body += chunk;
			const url = new URL(request.url, 'http://localhost');
			instance.requests.push({
				method: request.method,
				path: url.pathname,
				authorization: request.headers.authorization,
			});
			let json;
			let status = 200;
			if (request.method === 'POST' && url.pathname === '/Memory/import') {
				const { rows } = JSON.parse(body);
				instance.imports.push(rows);
				json = {
					results: rows.map((row) => {
						const existing = instance.memories.find((memory) => memory.id === row.id);
						if (!existing) instance.memories.push(view('x', { ...row, title: row.title ?? null }));
						return { id: row.id, result: existing ? 'unchanged' : 'created' };
					}),
				};
			} else if (instance.listStatus !== 200) {
				status = instance.listStatus;
				json = { error: 'nope', code: 'include_withdrawn_forbidden' };
			} else {
				const limit = Number(url.searchParams.get('limit'));
				const after = url.searchParams.get('after');
				const sorted = [...instance.memories].sort((a, b) =>
					a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
				);
				const start = after ? sorted.findIndex((memory) => `${memory.createdAt},${memory.id}` === after) + 1 : 0;
				json = { memories: sorted.slice(start, start + limit) };
				if (instance.acknowledges && url.searchParams.get('includeWithdrawn') === 'true') json.includeWithdrawn = true;
			}
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(json));
		},
	};
	return instance;
}

const servers = [];
async function listen(instance) {
	const server = createServer((request, response) => {
		instance.handle(request, response).catch((error) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	servers.push(server);
	return `http://127.0.0.1:${server.address().port}`;
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

let source;
let target;
let sourceUrl;
let targetUrl;

async function cli(argv, { env = ENV, ...options } = {}) {
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, env, { stdout, stderr, ...options });
	for (const secret of [FROM_AUTH, TO_AUTH, 'target-token-value', 'c291cmNlOnNlY3JldA']) {
		assert.ok(!stdout.text.includes(secret) && !stderr.text.includes(secret), 'no credential in the output');
	}
	return { code, stdout: stdout.text, stderr: stderr.text, report: code === 2 ? undefined : safeJson(stdout.text) };
}
const safeJson = (text) => (text ? JSON.parse(text) : undefined);

before(async () => {
	source = fakeInstance();
	target = fakeInstance();
	sourceUrl = await listen(source);
	targetUrl = await listen(target);
});

beforeEach(() => {
	for (const instance of [source, target]) {
		instance.memories = [];
		instance.imports = [];
		instance.requests = [];
		instance.acknowledges = true;
		instance.listStatus = 200;
	}
});

after(() => {
	for (const server of servers) server.close();
});

describe('toImportRow', () => {
	it('carries the import fields, drops nulls and server-owned state', () => {
		const flag = { kind: 'possible-customer-detail', since: '2025-01-02T00:00:00.000Z', source: 'model' };
		assert.deepEqual(
			toImportRow(
				view('a', {
					title: 'T',
					tags: ['ops'],
					evidence: [{ kind: 'pr', ref: 'x#1' }],
					status: 'withdrawn',
					supersedes: [idFor('b')],
					supersededBy: idFor('c'),
					contentFlag: flag,
					confirmed: { by: 'alice', at: '2025-01-03T00:00:00.000Z' },
					withdrawnAt: '2025-01-04T00:00:00.000Z',
					withdrawnReason: 'stale',
				}),
			),
			{
				id: idFor('a'),
				ownerId: 'alice',
				content: 'content a',
				tags: ['ops'],
				evidence: [{ kind: 'pr', ref: 'x#1' }],
				scopes: ['global'],
				status: 'withdrawn',
				supersedes: [idFor('b')],
				createdAt: '2025-01-01T00:00:00.000Z',
				title: 'T',
				supersededBy: idFor('c'),
				withdrawnAt: '2025-01-04T00:00:00.000Z',
				withdrawnReason: 'stale',
				contentFlag: flag,
			},
		);
	});
});

describe('differences', () => {
	const flag = { kind: 'possible-customer-detail', since: '2025-01-02T00:00:00.000Z', source: 'pattern' };
	it('ignores server-owned state and accepts a target flag the source lacks, never the reverse', () => {
		assert.deepEqual(differences(toImportRow(view('a')), view('a', { revision: 1, author: null })), []);
		assert.deepEqual(differences(toImportRow(view('a')), view('a', { contentFlag: flag })), []);
		assert.deepEqual(differences(toImportRow(view('a', { contentFlag: flag })), view('a')), ['contentFlag']);
		assert.deepEqual(
			differences(toImportRow(view('a')), view('a', { status: 'superseded', supersededBy: idFor('b') })),
			['status', 'supersededBy'],
		);
	});
});

describe('successorOrder', () => {
	const row = (tag, createdAt, supersedes = [], status = 'active') =>
		toImportRow(view(tag, { createdAt, supersedes: supersedes.map(idFor), status }));

	it('puts every live successor before what it supersedes, a shared predecessor after all of them', () => {
		const rows = [
			row('a', '2025-01-01T00:00:00.000Z'),
			row('b', '2025-01-02T00:00:00.000Z', ['a']),
			row('c', '2025-01-03T00:00:00.000Z', ['b']),
			row('d', '2025-01-01T12:00:00.000Z', ['a']),
			// An older row that a link made the replacement of a newer one.
			row('e', '2024-06-01T00:00:00.000Z', ['c']),
			row('w', '2025-05-01T00:00:00.000Z', ['e'], 'withdrawn'),
		];
		const order = successorOrder(rows).map((entry) => entry.id);
		const before = (x, y) => order.indexOf(idFor(x)) < order.indexOf(idFor(y));
		assert.equal(order.length, rows.length);
		for (const [x, y] of [
			['e', 'c'],
			['c', 'b'],
			['b', 'a'],
			['d', 'a'],
		]) {
			assert.ok(before(x, y), `${x} before ${y}: ${order}`);
		}
	});

	it('refuses a live cycle and ignores one through a withdrawn row', () => {
		assert.throws(
			() => successorOrder([row('a', '2025-01-01T00:00:00.000Z', ['b']), row('b', '2025-01-02T00:00:00.000Z', ['a'])]),
			/supersession cycle/,
		);
		assert.equal(
			successorOrder([
				row('a', '2025-01-01T00:00:00.000Z', ['b'], 'withdrawn'),
				row('b', '2025-01-02T00:00:00.000Z', ['a']),
			]).length,
			2,
		);
	});
});

describe('run', () => {
	const seed = (count) => {
		for (let n = 0; n < count; n++) {
			source.memories.push(
				view(`row${n}`, {
					createdAt: `2025-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
					status: n % 7 === 0 ? 'withdrawn' : 'active',
					scopes: n % 3 === 0 ? ['user:alice'] : ['global'],
				}),
			);
		}
	};

	it('copies in batches, verifies, and a re-run reports every row unchanged', async () => {
		seed(120);
		const first = await cli(['--from', sourceUrl, '--to', targetUrl, '--batch-size', '40']);
		assert.equal(first.code, 0, first.stderr);
		assert.equal(first.report.imported.created, 120);
		assert.equal(first.report.verified.present, 120);
		assert.deepEqual(
			target.imports.map((rows) => rows.length),
			[40, 40, 40],
		);
		assert.ok(source.requests.every((request) => request.authorization === FROM_AUTH));
		assert.ok(target.requests.every((request) => request.authorization === TO_AUTH));
		const second = await cli(['--from', sourceUrl, '--to', targetUrl]);
		assert.equal(second.code, 0, second.stderr);
		assert.equal(second.report.imported.unchanged, 120);
		assert.equal(second.report.imported.created, 0);
	});

	it('--dry-run reads the source only and counts by status and scope', async () => {
		seed(10);
		source.memories[1].confirmed = { by: 'alice', at: '2025-01-01T00:00:00.000Z' };
		const { code, report } = await cli(['--from', sourceUrl, '--dry-run'], {
			env: { AGENT_MEMORY_FROM_AUTHORIZATION: FROM_AUTH },
		});
		assert.equal(code, 0);
		assert.deepEqual(report.source.byStatus, { withdrawn: 2, active: 8 });
		assert.deepEqual(report.source.byScope, { 'user:alice': 4, global: 6 });
		assert.deepEqual(report.source.notCarried, { confirmed: 1 });
		assert.equal(target.requests.length, 0);
	});

	it('refuses a target holding other memories, or a differing copy, before writing', async () => {
		seed(3);
		target.memories.push(view('foreign'));
		let result = await cli(['--from', sourceUrl, '--to', targetUrl]);
		assert.equal(result.code, 1);
		assert.deepEqual(result.report.preflight.foreign, [idFor('foreign')]);
		target.memories = [{ ...source.memories[0], content: 'edited on the target' }];
		result = await cli(['--from', sourceUrl, '--to', targetUrl]);
		assert.equal(result.code, 1);
		assert.deepEqual(result.report.preflight.mismatched, [{ id: source.memories[0].id, fields: ['content'] }]);
		assert.equal(target.imports.length, 0);
	});

	it('refuses a source that does not acknowledge includeWithdrawn, or refuses it', async () => {
		seed(3);
		source.acknowledges = false;
		let result = await cli(['--from', sourceUrl, '--to', targetUrl]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /does not list withdrawn memories/);
		source.acknowledges = true;
		source.listStatus = 403;
		result = await cli(['--from', sourceUrl, '--to', targetUrl]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /HTTP 403 \(include_withdrawn_forbidden\)/);
		assert.equal(target.requests.length, 0);
	});

	it('refuses a source past the buffer bound before touching the target', async () => {
		seed(5);
		const result = await cli(['--from', sourceUrl, '--to', targetUrl], { maxBufferedChars: 30 });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /more than 30 characters/);
		assert.equal(target.requests.length, 0);
	});

	it('reports a target that does not match after the import', async () => {
		seed(2);
		const handle = target.handle;
		target.handle = async (request, response) => {
			await handle(request, response);
			if (request.method === 'POST') target.memories[0].status = 'superseded';
		};
		try {
			const result = await cli(['--from', sourceUrl, '--to', targetUrl]);
			assert.equal(result.code, 1);
			assert.equal(result.report.verified.mismatched.length, 1);
		} finally {
			target.handle = handle;
		}
	});

	it('takes credentials from the environment only', async () => {
		let result = await cli(['--from', sourceUrl, '--to', targetUrl], { env: {} });
		assert.equal(result.code, 2);
		assert.match(result.stderr, /AGENT_MEMORY_FROM_AUTHORIZATION/);
		result = await cli(['--from', 'http://user:pw@127.0.0.1:1', '--to', targetUrl]);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /must not embed credentials/);
		result = await cli(['--from', sourceUrl, '--to', sourceUrl]);
		assert.equal(result.code, 2);
	});
});
