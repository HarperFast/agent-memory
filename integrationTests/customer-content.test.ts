// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-content');
const PASSWORD = 'Memory-test-1!';
// Synthetic names only. Vexmorrow is never written to a memory, so finding it in a log can only mean the list leaked.
const NAMES = {
	zorblax: ['Zorblax Industries', 'Zorblax'],
	quintessa: ['Quintessa Bank', 'QB Holdings'],
	vexmorrow: ['Vexmorrow Ltd'],
};

suite('@harperfast/agent-memory customer-content check over HTTP', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const authFor = (user: string) =>
		user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: authFor('admin') },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${text}`);
		return JSON.parse(text);
	}

	async function call(
		user: string,
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	) {
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: authFor(user),
				...extraHeaders,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, etag: response.headers.get('etag'), body: parsed };
	}

	const put = async (user: string, id: string, input: object, revision?: number) => {
		const response = await call(user, 'PUT', id, input, revision ? { 'If-Match': `"${revision}"` } : undefined);
		ok(
			response.status === 200 || response.status === 201,
			`PUT ${id} → ${response.status} ${JSON.stringify(response.body)}`,
		);
		return response.body;
	};
	const search = async (user: string, query: string) => {
		const response = await call(user, 'GET', `?${query}`);
		strictEqual(response.status, 200, JSON.stringify(response.body));
		return (response.body.memories as any[]).map((memory) => memory.id);
	};
	const shared = (content: string, extra: object = {}) => ({
		title: 'Replication incident',
		content,
		visibility: 'shared',
		...extra,
	});
	async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000) {
		const deadline = Date.now() + timeoutMs;
		let value = await read();
		while (!done(value)) {
			if (Date.now() > deadline) throw new Error(`condition not reached; last value ${JSON.stringify(value)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
			value = await read();
		}
		return value;
	}

	async function openSSE(user: string, urlPath: string) {
		const controller = new AbortController();
		const response = await fetch(`${ctx.harper.httpURL}${urlPath}`, {
			headers: { Accept: 'text/event-stream', Authorization: authFor(user) },
			signal: controller.signal,
		});
		strictEqual(response.status, 200);
		const events: any[] = [];
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		void (async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';
					for (const line of lines) {
						const raw = line.startsWith('data:') ? line.slice(5).trim() : '';
						if (!raw) continue;
						try {
							events.push(JSON.parse(raw));
						} catch {
							// Not a JSON frame.
						}
					}
				}
			} catch {
				// Aborted on close.
			}
		})();
		return {
			events,
			async waitFor(predicate: (event: any) => boolean, timeoutMs = 15_000) {
				const deadline = Date.now() + timeoutMs;
				while (!events.some(predicate)) {
					if (Date.now() > deadline) throw new Error(`no matching event; received ${JSON.stringify(events)}`);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			},
			close: () => controller.abort(),
		};
	}

	async function mcpCall(user: string, method: string, params: Record<string, unknown> = {}, sessionId?: string) {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: authFor(user),
		};
		if (sessionId) {
			headers['Mcp-Session-Id'] = sessionId;
			headers['MCP-Protocol-Version'] = '2025-06-18';
		}
		const response = await fetch(`${ctx.harper.httpURL}/mcp`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		return {
			status: response.status,
			sessionId: response.headers.get('mcp-session-id') ?? undefined,
			body: JSON.parse(await response.text()),
		};
	}
	async function mcpSession(user: string) {
		const init = await mcpCall(user, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'customer-content-test', version: '1.0.0' },
		});
		strictEqual(init.status, 200, JSON.stringify(init.body));
		return init.sessionId!;
	}
	const tool = async (user: string, session: string, name: string, args: object) =>
		(await mcpCall(user, 'tools/call', { name, arguments: args }, session)).body.result;

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: {
				logging: { stdStreams: true },
				authentication: { authorizeLocal: false },
				mcp: { application: { mountPath: '/mcp' } },
			},
			env: { AGENT_MEMORY_TEST_CUSTOMER_NAMES: JSON.stringify(NAMES) },
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['owner', 'fleet', 'dave', 'rhea', 'carol']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				// The fleet's role: global only.
				{ id: 'role:member', read: ['global'], write: ['global'] },
				{ id: 'user:dave', read: ['customer:*'], write: ['customer:*'] },
				{ id: 'user:rhea', read: ['customer:*'] },
				{ id: 'user:carol', read: ['customer:zorblax'], write: ['customer:zorblax'] },
			],
		});
		const deadline = Date.now() + 60_000;
		let ready = await call('admin', 'GET', '?q=warmup');
		while (ready.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			ready = await call('admin', 'GET', '?q=warmup');
		}
		strictEqual(ready.status, 200, JSON.stringify(ready.body));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a global write naming a customer or matching a host pattern is committed, flagged and hidden from global readers everywhere', async () => {
		const named = memId('named');
		const hosted = memId('hosted');
		const flagged = await put('owner', named, shared('Zorblax saw replication lag after compaction'));
		deepStrictEqual(Object.keys(flagged.contentFlag).sort(), ['kind', 'since', 'source']);
		strictEqual(flagged.contentFlag.kind, 'possible-customer-detail');
		const byHost = await put(
			'owner',
			hosted,
			shared('replication lag after compaction', {
				evidence: [{ kind: 'url', ref: 'https://db1.zorbcloud.test/status' }],
			}),
		);
		ok(byHost.contentFlag);

		const missing = await call('fleet', 'GET', '0'.repeat(32));
		strictEqual(missing.status, 404);
		for (const id of [named, hosted]) {
			for (const reader of ['fleet', 'carol'])
				deepStrictEqual(await call(reader, 'GET', id), missing, `${reader} ${id}`);
			strictEqual((await call('owner', 'GET', id)).status, 200);
			strictEqual((await call('rhea', 'GET', id)).status, 200);
		}
		strictEqual((await call('owner', 'GET', named)).body.memory.contentFlag.labels, undefined);
		deepStrictEqual((await call('rhea', 'GET', named)).body.memory.contentFlag.labels, ['customer:zorblax']);
		deepStrictEqual((await call('rhea', 'GET', hosted)).body.memory.contentFlag.labels, ['zorb-host']);

		for (const query of ['q=replication', 'q=Zorblax', '', 'flagged=true']) {
			const ids = await search('fleet', query);
			ok(!ids.includes(named) && !ids.includes(hosted), `${query}: ${ids}`);
		}
		const reviewQueue = await search('dave', 'flagged=true');
		ok(reviewQueue.includes(named) && reviewQueue.includes(hosted), String(reviewQueue));
		deepStrictEqual((await search('owner', 'flagged=true')).sort(), [hosted, named].sort());

		const session = await mcpSession('fleet');
		deepStrictEqual(
			await tool('fleet', session, 'get', { id: named }),
			await tool('fleet', session, 'get', { id: memId('mcp-missing') }),
		);
		const recalled = await tool('fleet', session, 'recall', { q: 'replication' });
		const recalledIds = JSON.parse(recalled.content[0].text).memories.map((memory: any) => memory.id);
		ok(!recalledIds.includes(named) && !recalledIds.includes(hosted), String(recalledIds));
		const read = await mcpCall('fleet', 'resources/read', { uri: `memory:///${named}` }, session);
		const readMissing = await mcpCall('fleet', 'resources/read', { uri: `memory:///${memId('mcp-missing')}` }, session);
		ok(read.body.error, JSON.stringify(read.body));
		strictEqual(read.body.error.code, readMissing.body.error.code);
	});

	test('the quarantine is applied in both lanes before the limit, and a row written before the flag existed stays readable', async () => {
		const control = memId('okapi-ctl');
		await put('fleet', control, shared('okapi grazing near the river at dawn'));
		for (let i = 0; i < 4; i++) await put('owner', memId(`okapi-${i}`), shared(`Zorblax okapi okapi okapi ${i}`));
		deepStrictEqual(await search('fleet', 'q=okapi&limit=1'), [control]);
		deepStrictEqual(await search('fleet', 'limit=1'), [control]);

		const legacy = memId('legacy');
		const written = await fetch(`${ctx.harper.httpURL}/LegacyMemoryWriter/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authFor('admin') },
			body: JSON.stringify({
				id: legacy,
				title: 'legacy tapir notes',
				content: 'tapir feeding schedule from before the flag existed',
				tags: ['legacy-row'],
				scopes: ['global'],
				ownerId: 'owner',
				status: 'active',
				revision: 1,
				evidence: [],
				evidenceMemoryIds: [],
				supersedes: [],
				supersededBy: null,
				validUntil: null,
				embeddingModel: 'default',
				createdAt: new Date().toISOString(),
			}),
		});
		strictEqual(written.status, 200, await written.text());
		strictEqual((await call('fleet', 'GET', legacy)).status, 200);
		ok((await search('fleet', 'q=tapir')).includes(legacy));
		deepStrictEqual(await search('fleet', 'tag=legacy-row'), [legacy]);
	});

	test('a global reader is never told about a flagged memory; the owner hears about every flag on /MemoryEvents', async () => {
		const watched = memId('watched');
		const sentinel = memId('sentinel');
		const named = memId('named-live');
		const modelled = memId('modelled');
		await put('owner', watched, shared('clean runbook for compaction'));
		await put('owner', sentinel, shared('clean sentinel'));
		strictEqual((await call('fleet', 'POST', 'watch', { ids: [watched, sentinel] })).status, 200);
		const fleetRecords = await openSSE('fleet', '/Memory/');
		const fleetEvents = await openSSE('fleet', '/MemoryEvents');
		const ownerEvents = await openSSE('owner', '/MemoryEvents');
		try {
			await put('owner', named, shared('Zorblax compaction notes'));
			await put('owner', watched, { content: 'compaction runbook for Quintessa Bank' }, 1);
			await put('owner', modelled, shared('MODEL-SAYS-CUSTOMER compaction notes'));
			await ownerEvents.waitFor((event) => event.id === named && event.kind === 'created');
			await ownerEvents.waitFor((event) => event.id === watched && event.revision === 2);
			await ownerEvents.waitFor((event) => event.id === modelled && event.kind === 'flagged');
			await put('owner', sentinel, { content: 'clean sentinel, revised' }, 1);
			await fleetRecords.waitFor((event) => event.id === sentinel && event.revision === 2);
			await fleetEvents.waitFor((event) => event.id === sentinel && event.revision === 2);
		} finally {
			fleetRecords.close();
			fleetEvents.close();
			ownerEvents.close();
		}
		const told = [...fleetRecords.events, ...fleetEvents.events].map(({ id, kind, revision }) => [id, kind, revision]);
		ok(!told.some(([id]) => id === named), JSON.stringify(told));
		ok(!told.some(([id, , revision]) => id === watched && revision >= 2), JSON.stringify(told));
		// Visible between its commit and the model's verdict: the model check is advisory and after commit.
		ok(!told.some(([id, kind]) => id === modelled && kind !== 'created'), JSON.stringify(told));
		strictEqual((await call('fleet', 'GET', modelled)).status, 404);
		strictEqual((await call('owner', 'GET', modelled)).body.memory.contentFlag.source, 'model');
	});

	test('review: a customer:* writer rescopes or confirms, an uncleared owner cannot confirm, and adding a match re-flags', async () => {
		const rescoped = memId('rescoped');
		await put('owner', rescoped, shared('Zorblax failover drill'));
		const moved = await put('dave', rescoped, { scopes: ['customer:zorblax'] }, 1);
		strictEqual(moved.contentFlag, null);
		strictEqual((await call('fleet', 'GET', rescoped)).status, 404);
		strictEqual((await call('carol', 'GET', rescoped)).status, 200);
		strictEqual((await call('owner', 'GET', rescoped)).status, 200);

		const confirmed = memId('confirmed');
		await put('owner', confirmed, shared('Zorblax is also a constellation in our test fixtures'));
		const byOwner = await call('owner', 'POST', `${confirmed}/confirm-scope`, {});
		strictEqual(byOwner.status, 403);
		strictEqual(byOwner.body.code, 'customer_clearance_required');
		const review = await call('dave', 'POST', `${confirmed}/confirm-scope`, {}, { 'If-Match': '"1"' });
		strictEqual(review.status, 200, JSON.stringify(review.body));
		strictEqual(review.body.memory.contentFlag, null);
		strictEqual(review.body.memory.scopeConfirmed.by, 'dave');
		strictEqual((await call('fleet', 'GET', confirmed)).status, 200);

		strictEqual((await put('owner', confirmed, { validUntil: '2999-01-01T00:00:00Z' }, 2)).contentFlag, null);
		strictEqual((await call('fleet', 'GET', confirmed)).status, 200);
		ok((await put('owner', confirmed, { content: 'Zorblax runs on db7.zorbcloud.test' }, 3)).contentFlag);
		strictEqual((await call('fleet', 'GET', confirmed)).status, 404);

		const session = await mcpSession('dave');
		const viaMcp = await tool('dave', session, 'confirm-scope', { id: confirmed, revision: 4 });
		strictEqual(JSON.parse(viaMcp.content[0].text).memory.contentFlag, null);
		strictEqual((await call('fleet', 'GET', confirmed)).status, 200);
	});

	test('the model check flags after commit, and the write itself is never held or rejected', async () => {
		const id = memId('model-only');
		const response = await call('owner', 'PUT', id, shared('MODEL-SAYS-CUSTOMER migration notes'));
		strictEqual(response.status, 201);
		strictEqual(response.body.contentFlag, null);
		const flagged = await eventually(
			() => call('owner', 'GET', id),
			(read) => read.body.memory?.contentFlag?.source === 'model',
		);
		strictEqual(flagged.body.memory.revision, 2);
		strictEqual((await call('fleet', 'GET', id)).status, 404);
	});

	test('mode off disables the check and keeps existing flags enforced; the names list is never logged', async () => {
		const appDir = join(ctx.harper.dataRootDir, 'components', 'memory-app-content');
		const configPath = join(appDir, 'config.yaml');
		writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('mode: flag', 'mode: off'));
		let attempt = 0;
		await eventually(
			async () => (await put('owner', memId(`mode-off-${++attempt}`), shared('Zorblax after mode off'))).contentFlag,
			(contentFlag) => contentFlag === null,
			30_000,
		);
		strictEqual((await call('fleet', 'GET', memId('named'))).status, 404);

		// The runner always gives a suite a log directory (hdb.log, stdout.log, stderr.log).
		const logDir = ctx.harper.logDir!;
		const logs = readdirSync(logDir)
			.filter((name) => name.endsWith('.log'))
			.map((name) => readFileSync(join(logDir, name), 'utf8'));
		ok(
			logs.some((text) => text.includes('add_user')),
			'expected the instance log, which records the suite setup',
		);
		for (const text of logs) ok(!/vexmorrow/i.test(text), 'a names-list entry reached a log');
	});
});
