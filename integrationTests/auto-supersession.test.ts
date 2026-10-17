// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-auto');
const PASSWORD = 'Memory-test-1!';

suite('@harperfast/agent-memory supersession auto mode over HTTP', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: basic(ctx.harper.admin.username, ctx.harper.admin.password),
			},
			body: JSON.stringify(body),
		});
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${await response.text()}`);
	}

	async function call(user: string, method: string, path: string, body?: unknown) {
		const authorization =
			user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['alice', 'bob']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [{ id: 'role:member', read: ['global', 'team:y'], write: ['global', 'team:y'] }],
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

	// Candidate search does not wait for index coverage; a search does, so it settles the index between steps.
	const settleIndex = () => call('admin', 'GET', '?q=grebe');
	const shape = (candidates: any[]) =>
		candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied: applied ?? null }));
	const grebe = (suffix: string, extra: object = {}) => ({
		title: 'grebe count',
		content: `grebe colony counted at forty pairs on the north lake${suffix}`,
		visibility: 'shared',
		...extra,
	});

	test('a judged supersedes verdict on create supersedes through the explicit rules; an identical retry stays a 200', async () => {
		const original = await call('alice', 'PUT', memId('grebe-v1'), grebe(''));
		strictEqual(original.status, 201, JSON.stringify(original.body));
		const wider = await call('alice', 'PUT', memId('grebe-wide'), grebe(' wide', { scopes: ['global', 'team:y'] }));
		strictEqual(wider.status, 201, JSON.stringify(wider.body));
		await settleIndex();

		const replacing = await call('bob', 'PUT', memId('grebe-v2'), grebe(' REPLACES'));
		strictEqual(replacing.status, 201, JSON.stringify(replacing.body));
		const decided = shape(replacing.body.candidates);
		ok(
			decided.some((candidate) => candidate.id === original.body.id && candidate.applied === true),
			JSON.stringify(decided),
		);
		ok(
			decided.some((candidate) => candidate.id === wider.body.id && candidate.applied === false),
			'a supersede that would narrow scopes is reported, not applied',
		);

		const old = (await call('alice', 'GET', original.body.id)).body.memory;
		strictEqual(old.status, 'superseded');
		strictEqual(old.supersededBy, replacing.body.id);
		strictEqual((await call('alice', 'GET', wider.body.id)).body.memory.status, 'active');
		const replacement = (await call('bob', 'GET', replacing.body.id)).body.memory;
		deepStrictEqual(replacement.autoSupersedes, [original.body.id]);
		deepStrictEqual(replacement.supersedes, [original.body.id]);

		const retried = await call('bob', 'PUT', memId('grebe-v2'), grebe(' REPLACES'));
		strictEqual(retried.status, 200, JSON.stringify(retried.body));
		strictEqual(retried.body.revision, 1);
	});
});
