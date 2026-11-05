// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-cluster-lock');

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
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
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
