// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-cluster-lock');
const guardFixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-lock-guard');
const harperBinPath = () =>
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ?? join(dirname(require.resolve('harper')), 'bin', 'harper.js');

suite('@harperfast/agent-memory at lockScope: cluster without record locks', (ctx: ContextWithHarper) => {
	const authorization = () =>
		'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const seeded = 'mem-seeded-lock-scope';

	async function call(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) {
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: authorization(),
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
		return { status: response.status, body: parsed };
	}

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath: harperBinPath(),
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
		const response = await fetch(`${ctx.harper.httpURL}/SeedMemory/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: authorization() },
			body: JSON.stringify({
				id: seeded,
				title: 'Seeded',
				content: 'seeded beneath the plugin',
				ownerId: ctx.harper.admin.username,
				scopes: [],
				status: 'active',
				revision: 1,
				validUntil: null,
				embeddingModel: 'default',
				createdAt: new Date().toISOString(),
			}),
		});
		ok(response.ok, `seeding → ${response.status} ${await response.text()}`);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('lifecycle writes and pins fail closed with 503 unavailable', async () => {
		const writes = [
			await call('PUT', 'mem-created-lock-scope', { title: 'New', content: 'never written' }),
			await call('PUT', seeded, { content: 'revised' }, { 'If-Match': '"1"' }),
			await call('POST', `${seeded}/confirm`, {}),
			await call('POST', `${seeded}/pin`, {}),
			await call('DELETE', `${seeded}?reason=test`, undefined, { 'If-Match': '"1"' }),
		];
		deepStrictEqual(
			writes.map(({ status, body }) => [status, body?.code]),
			writes.map(() => [503, 'unavailable']),
		);
		const read = await call('GET', seeded);
		strictEqual(read.body.memory.revision, 1);
		strictEqual(read.body.memory.content, 'seeded beneath the plugin');
	});

	test('a component that requires cluster ordering starts, and reads the scope through the plugin', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/LockScopeGuard`, {
			headers: { Accept: 'application/json', Authorization: authorization() },
		});
		strictEqual(response.status, 200);
		deepStrictEqual(await response.json(), { lockScope: 'cluster' });
	});

	test('reads, watch=true included, never take a cluster lock', async () => {
		strictEqual((await call('GET', seeded)).status, 200);
		const searched = await call('GET', '?watch=true');
		strictEqual(searched.status, 200, JSON.stringify(searched.body));
		ok(searched.body.memories.some((memory: any) => memory.id === seeded));
		const bootstrap = await call('GET', 'bootstrap?watch=true');
		strictEqual(bootstrap.status, 200, JSON.stringify(bootstrap.body));
		const watched = await call('POST', 'watch', { ids: [seeded] });
		strictEqual(watched.status, 200, JSON.stringify(watched.body));
		deepStrictEqual(watched.body.watched, [seeded]);
	});
});

suite('a component that requires lockScope: cluster, beside agent-memory at node', (ctx: ContextWithHarper) => {
	const authorization = () =>
		'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const get = (path: string) =>
		fetch(`${ctx.harper.httpURL}/${path}`, { headers: { Accept: 'application/json', Authorization: authorization() } });

	before(async () => {
		await setupHarperWithFixture(ctx, guardFixturePath, {
			harperBinPath: harperBinPath(),
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('refuses to start, and agent-memory keeps serving', async () => {
		// Harper answers a component that failed to load with its load error.
		const guard = await get('LockScopeGuard');
		strictEqual(guard.status, 500);
		const failure = await guard.json();
		strictEqual(failure.code, 'ResourceLoadError');
		ok(failure.title.includes('needs agent-memory lockScope cluster; it reports node'), failure.title);
		const listed = await get('Memory/');
		strictEqual(listed.status, 200, await listed.text());
	});
});
