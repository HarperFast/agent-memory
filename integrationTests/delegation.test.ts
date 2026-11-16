// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app');
const PASSWORD = 'Delegation-test-1!';

// kris is the person; agent-a acts for kris with global-only grants; carol is someone else.
suite('@harperfast/agent-memory delegation over HTTP', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: basic(ctx.harper.admin.username, ctx.harper.admin.password),
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${text}`);
		return JSON.parse(text);
	}

	async function call(user: string, method: string, path: string, body?: unknown, revision?: number) {
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: basic(user, PASSWORD),
				...(revision !== undefined && { 'If-Match': `"${revision}"` }),
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

	const memId = (tag: string) => `mem-dlg-${tag}`.padEnd(16, '_');
	const delegate = (id: string, actsFor: string) =>
		operation({ operation: 'upsert', database: 'memory', table: 'Delegation', records: [{ id, actsFor }] });
	const revoke = (id: string) => operation({ operation: 'delete', database: 'memory', table: 'Delegation', ids: [id] });

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: {
				threads: { count: 1 },
				logging: { stdStreams: true },
				authentication: { authorizeLocal: false },
			},
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['kris', 'agent-a', 'carol']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				{ id: 'role:member', read: ['global'], write: ['global'] },
				{ id: 'user:kris', read: ['customer:*'], write: ['customer:*'] },
			],
		});
		await delegate('agent-a', 'kris');
		const deadline = Date.now() + 60_000;
		let ready = await call('kris', 'GET', '?q=warmup');
		while (ready.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			ready = await call('kris', 'GET', '?q=warmup');
		}
		strictEqual(ready.status, 200, JSON.stringify(ready.body));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test("a delegate revises the principal's memory as the principal, until the row is revoked", async () => {
		const id = memId('revise');
		strictEqual(
			(await call('kris', 'PUT', id, { title: 'imported', content: 'stale conclusion', visibility: 'shared' })).status,
			201,
		);
		const revised = await call('agent-a', 'PUT', id, { content: 'corrected conclusion' }, 1);
		strictEqual(revised.status, 200, JSON.stringify(revised.body));
		const memory = (await call('kris', 'GET', id)).body.memory;
		strictEqual(memory.ownerId, 'kris');
		strictEqual(memory.content, 'corrected conclusion');
		strictEqual(memory.lastEditor.principalId, 'agent-a');

		const refused = await call('carol', 'PUT', id, { content: 'carol edit' }, 2);
		strictEqual(refused.status, 403);
		strictEqual(refused.body.code, 'not_memory_owner');
		ok(refused.body.error.includes(`supersedes: ["${id}"]`), refused.body.error);

		await revoke('agent-a');
		try {
			const afterRevoke = await call('agent-a', 'PUT', id, { content: 'after revoke' }, 2);
			strictEqual(afterRevoke.status, 403, JSON.stringify(afterRevoke.body));
			strictEqual(afterRevoke.body.code, 'not_memory_owner');
		} finally {
			await delegate('agent-a', 'kris');
		}
	});

	test('user:<principal> is shared with the delegate and 404 to anyone else', async () => {
		const byAgent = memId('agent-note');
		const created = await call('agent-a', 'PUT', byAgent, { title: 'agent note', content: 'private to the person' });
		strictEqual(created.status, 201, JSON.stringify(created.body));
		const stored = (await call('kris', 'GET', byAgent)).body.memory;
		deepStrictEqual(stored.scopes, ['user:kris']);
		strictEqual(stored.ownerId, 'kris');
		strictEqual(stored.author.principalId, 'agent-a');

		const byKris = memId('kris-note');
		strictEqual((await call('kris', 'PUT', byKris, { title: 'kris note', content: 'kris private' })).status, 201);
		strictEqual((await call('agent-a', 'GET', byKris)).status, 200);
		strictEqual((await call('agent-a', 'PUT', byKris, { content: 'agent edit' }, 1)).status, 200);

		for (const id of [byAgent, byKris]) {
			strictEqual((await call('carol', 'GET', id)).status, 404);
			strictEqual((await call('carol', 'PUT', id, { content: 'x' }, 1)).status, 409);
		}
		const carolSees = (await call('carol', 'GET', '?limit=50')).body.memories.map((memory: any) => memory.id);
		ok(!carolSees.includes(byAgent) && !carolSees.includes(byKris));
		const agentSees = (await call('agent-a', 'GET', '?limit=50')).body.memories.map((memory: any) => memory.id);
		ok(agentSees.includes(byAgent) && agentSees.includes(byKris));
	});

	test("a global-only delegate is denied the principal's customer memory", async () => {
		const id = memId('customer');
		strictEqual(
			(await call('kris', 'PUT', id, { title: 'acme incident', content: 'acme detail', scopes: ['customer:acme'] }))
				.status,
			201,
		);
		strictEqual((await call('agent-a', 'GET', id)).status, 404);
		strictEqual((await call('agent-a', 'PUT', id, { content: 'x' }, 1)).status, 409);
		strictEqual((await call('agent-a', 'DELETE', id, undefined, 1)).status, 404);
		strictEqual((await call('agent-a', 'POST', `${id}/confirm`, {})).status, 404);
		const agentSees = (await call('agent-a', 'GET', '?scope=customer:acme')).body.memories;
		deepStrictEqual(agentSees, []);
	});
});
