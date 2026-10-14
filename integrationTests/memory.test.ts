// Boots Harper with the packed plugin in a host app (fixtures/memory-app) and drives the Memory resource
// over HTTP as different Harper users. Run `npm run install:fixtures` first.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app');
const PASSWORD = 'Memory-test-1!';

suite('@harperfast/agent-memory over HTTP', (ctx: ContextWithHarper) => {
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

	async function call(user: string, method: string, path: string, body?: unknown) {
		const authorization =
			user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization },
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

	const create = async (user: string, input: Record<string, unknown>) => {
		const response = await call(user, 'POST', '', input);
		strictEqual(response.status, 201, JSON.stringify(response.body));
		return response.body.memory;
	};
	const search = async (user: string, query: string) => {
		const response = await call(user, 'GET', `?${query}`);
		strictEqual(response.status, 200, JSON.stringify(response.body));
		return response.body.memories as any[];
	};

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			// Harper otherwise treats a credential-less loopback request as super_user.
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['alice', 'bob', 'carol', 'dave', 'erin']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				{ id: 'role:member', read: ['global'], write: ['global'] },
				{ id: 'user:carol', read: ['customer:x'], write: ['customer:x'] },
				{ id: 'user:dave', read: ['customer:*'] },
			],
		});
		// A new table's full-text index builds after boot; until then search answers 503 unavailable.
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

	test('a private memory is invisible to another user: same 404 as a missing id, absent from search', async () => {
		const memory = await create('alice', {
			idempotencyKey: 'private-1',
			title: 'Alice private note',
			content: 'zebra migration patterns observed in the northern valley',
		});
		deepStrictEqual(memory.scopes, ['user:alice']);
		strictEqual((await call('alice', 'GET', memory.id)).status, 200);

		const unreadable = await call('bob', 'GET', memory.id);
		const missing = await call('bob', 'GET', '0'.repeat(32));
		strictEqual(unreadable.status, 404);
		deepStrictEqual(unreadable, missing);
		deepStrictEqual(await call('bob', 'POST', `${memory.id}/withdraw`, { expectedRevision: 1 }), missing);

		ok((await search('alice', 'q=zebra')).some((hit) => hit.id === memory.id));
		deepStrictEqual(await search('bob', 'q=zebra'), []);
	});

	test('the readable set is applied inside the vector lane, before its limit', async () => {
		for (let i = 0; i < 5; i++) {
			await create('alice', {
				idempotencyKey: `okapi-${i}`,
				title: 'okapi',
				content: `okapi okapi okapi sighting ${i}`,
			});
		}
		const bobs = await create('bob', {
			idempotencyKey: 'giraffe',
			title: 'giraffe',
			content: 'giraffe feeding schedule',
			visibility: 'shared',
		});
		// No full-text match is readable by bob, so only the vector lane can return his memory; a lane that
		// took its top-2 and then filtered would return nothing.
		deepStrictEqual(
			(await search('bob', 'q=okapi&limit=1')).map((hit) => hit.id),
			[bobs.id],
		);
	});

	test('a customer:x memory is visible only to customer:x and customer:* holders', async () => {
		const denied = await call('alice', 'POST', '', {
			idempotencyKey: 'not-allowed',
			title: 'nope',
			content: 'alice holds no customer grant',
			scopes: ['customer:x'],
		});
		strictEqual(denied.status, 403);
		strictEqual(denied.body.code, 'scope_not_writable');

		const memory = await create('carol', {
			idempotencyKey: 'cx-1',
			title: 'Customer X quirk',
			content: 'tapir replication lag appears after nightly compaction',
			scopes: ['customer:x'],
		});
		const hiddenFromY = await create('admin', {
			idempotencyKey: 'cy-1',
			title: 'Customer Y quirk',
			content: 'tapir caches warm slowly on customer y',
			scopes: ['customer:y'],
		});
		for (const reader of ['carol', 'dave', 'admin'])
			strictEqual((await call(reader, 'GET', memory.id)).status, 200, reader);
		for (const outsider of ['alice', 'bob'])
			strictEqual((await call(outsider, 'GET', memory.id)).status, 404, outsider);

		// The vector lane returns the nearest readable memories whatever their distance, so assert membership.
		const ids = async (user: string) => (await search(user, 'q=tapir')).map((hit) => hit.id);
		const carolHits = await ids('carol');
		ok(carolHits.includes(memory.id) && !carolHits.includes(hiddenFromY.id));
		const daveHits = await ids('dave');
		ok(daveHits.includes(memory.id) && daveHits.includes(hiddenFromY.id));
		const aliceHits = await ids('alice');
		ok(!aliceHits.includes(memory.id) && !aliceHits.includes(hiddenFromY.id));
	});

	test('tag= and scope= narrow results; scope= never widens them', async () => {
		const tagged = await create('alice', {
			idempotencyKey: 'lynx-tagged',
			title: 'lynx',
			content: 'lynx den location',
			tags: ['wildlife'],
			visibility: 'shared',
		});
		const untagged = await create('alice', {
			idempotencyKey: 'lynx-private',
			title: 'lynx',
			content: 'lynx den notes',
		});
		const hidden = await create('carol', {
			idempotencyKey: 'lynx-cx',
			title: 'lynx',
			content: 'lynx den customer',
			scopes: ['customer:x'],
		});
		deepStrictEqual(
			(await search('alice', 'q=lynx&tag=wildlife')).map((hit) => hit.id),
			[tagged.id],
		);
		deepStrictEqual(
			(await search('alice', 'q=lynx&scope=user:alice'))
				.map((hit) => hit.id)
				.filter((id) => [tagged.id, untagged.id].includes(id)),
			[untagged.id],
		);
		deepStrictEqual(await search('alice', 'q=lynx&scope=customer:x'), []);
		ok((await search('carol', 'q=lynx&scope=customer:x')).some((hit) => hit.id === hidden.id));
	});

	test('revoking a grant hides the memory on the next request', async () => {
		const memory = await create('carol', {
			idempotencyKey: 'cx-revoke',
			title: 'revocation',
			content: 'narwhal tusk telemetry',
			scopes: ['customer:x'],
		});
		strictEqual((await call('dave', 'GET', memory.id)).status, 200);
		await operation({ operation: 'delete', database: 'memory', table: 'ScopeGrant', ids: ['user:dave'] });
		try {
			strictEqual((await call('dave', 'GET', memory.id)).status, 404);
			ok(!(await search('dave', 'q=narwhal')).some((hit) => hit.id === memory.id));
		} finally {
			await operation({
				operation: 'upsert',
				database: 'memory',
				table: 'ScopeGrant',
				records: [{ id: 'user:dave', read: ['customer:*'] }],
			});
		}
	});

	test('supersede hides the old memory from default search; withdrawing the superseder restores it', async () => {
		const old = await create('alice', {
			idempotencyKey: 'heron-v1',
			title: 'heron threshold',
			content: 'heron alert threshold is 30 percent',
			visibility: 'shared',
		});
		const narrowing = await call('bob', 'POST', '', {
			idempotencyKey: 'heron-narrow',
			title: 'heron threshold',
			content: 'heron alert threshold is 25 percent',
			supersedes: [old.id],
		});
		strictEqual(narrowing.status, 403);
		strictEqual(narrowing.body.code, 'supersede_scope_narrowing');

		const replacement = await create('bob', {
			idempotencyKey: 'heron-v2',
			title: 'heron threshold',
			content: 'heron alert threshold is 25 percent',
			visibility: 'shared',
			supersedes: [old.id],
		});
		const superseded = (await call('alice', 'GET', old.id)).body.memory;
		strictEqual(superseded.status, 'superseded');
		strictEqual(superseded.supersededBy, replacement.id);
		strictEqual(superseded.revision, 2);

		const defaultHits = (await search('alice', 'q=heron')).map((hit) => hit.id);
		ok(defaultHits.includes(replacement.id));
		ok(!defaultHits.includes(old.id));
		ok((await search('alice', 'q=heron&includeSuperseded=true')).some((hit) => hit.id === old.id));

		const frozen = await call('alice', 'POST', `${old.id}/revise`, { expectedRevision: 2, content: 'edited' });
		strictEqual(frozen.status, 409);
		strictEqual(frozen.body.code, 'memory_superseded');

		const withdrawn = await call('bob', 'POST', `${replacement.id}/withdraw`, { expectedRevision: 1, reason: 'wrong' });
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		strictEqual(withdrawn.body.memory.status, 'withdrawn');
		const restored = (await call('alice', 'GET', old.id)).body.memory;
		strictEqual(restored.status, 'active');
		strictEqual(restored.supersededBy, null);

		const afterHits = (await search('alice', 'q=heron&includeSuperseded=true')).map((hit) => hit.id);
		ok(afterHits.includes(old.id));
		ok(!afterHits.includes(replacement.id), 'withdrawn memories never appear in search');
		strictEqual((await call('alice', 'GET', replacement.id)).status, 404);
		strictEqual((await call('bob', 'GET', replacement.id)).body.memory.status, 'withdrawn');
	});

	test('concurrent revisions at the same expected revision: exactly one succeeds, the rest get revision_conflict', async () => {
		const memory = await create('alice', { idempotencyKey: 'race', title: 'race', content: 'ibis count 3' });
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				call('alice', 'POST', `${memory.id}/revise`, {
					expectedRevision: 1,
					content: `ibis count ${i + 4}, embedded slowly`,
				}),
			),
		);
		deepStrictEqual(
			results.map((result) => result.status).sort(),
			[200, 409, 409, 409, 409, 409, 409, 409],
			JSON.stringify(results.map((result) => result.body)),
		);
		ok(results.filter((result) => result.status === 409).every((result) => result.body.code === 'revision_conflict'));
		strictEqual((await call('alice', 'GET', memory.id)).body.memory.revision, 2);
	});

	test('a supersede racing the withdrawal of an earlier superseder leaves the newest one in charge', async () => {
		const shared = (key: string, content: string, supersedes?: string[]) =>
			create('alice', { idempotencyKey: key, title: 'egret', content, visibility: 'shared', supersedes });
		const target = await shared('egret-t', 'egret roost one');
		const first = await shared('egret-w', 'egret roost two', [target.id]);
		// The new superseder embeds slowly, so it holds the target's lock while the withdrawal waits on it.
		const [replacement, withdrawn] = await Promise.all([
			call('alice', 'POST', '', {
				idempotencyKey: 'egret-n',
				title: 'egret',
				content: 'egret roost three, embedded slowly',
				visibility: 'shared',
				supersedes: [target.id],
			}),
			call('alice', 'POST', `${first.id}/withdraw`, { expectedRevision: 1 }),
		]);
		strictEqual(replacement.status, 201, JSON.stringify(replacement.body));
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		const after = (await call('alice', 'GET', target.id)).body.memory;
		strictEqual(after.status, 'superseded');
		strictEqual(after.supersededBy, replacement.body.memory.id);
	});

	test('a create superseding both ends of a chain does not deadlock with withdrawing the middle', async () => {
		const shared = (key: string, content: string, supersedes?: string[]) =>
			create('alice', { idempotencyKey: key, title: 'plover', content, visibility: 'shared', supersedes });
		const target = await shared('plover-t', 'plover nest one');
		const middle = await shared('plover-w', 'plover nest two', [target.id]);
		const started = Date.now();
		const results = await Promise.all([
			call('alice', 'POST', '', {
				idempotencyKey: 'plover-x',
				title: 'plover',
				content: 'plover nest three, embedded slowly',
				visibility: 'shared',
				supersedes: [target.id, middle.id],
			}),
			call('alice', 'POST', `${middle.id}/withdraw`, { expectedRevision: 1 }),
		]);
		ok(Date.now() - started < 10_000, 'both requests finished without waiting out a lock timeout');
		// Whichever runs second sees the first one's change and is refused with a 409.
		const [created, withdrawn] = results.map((result) => result.status);
		ok(
			(created === 201 && withdrawn === 409) || (created === 409 && withdrawn === 200),
			JSON.stringify(results.map((result) => result.body)),
		);
	});

	test('idempotent create: a retry returns the existing row, a different payload is a conflict', async () => {
		const input = { idempotencyKey: 'retry', title: 'retry', content: 'pelican nesting begins in march' };
		const first = await call('alice', 'POST', '', input);
		const retry = await call('alice', 'POST', '', input);
		strictEqual(first.status, 201);
		strictEqual(retry.status, 200);
		strictEqual(retry.body.memory.id, first.body.memory.id);
		strictEqual((await call('alice', 'POST', '', { ...input, content: 'other' })).body.code, 'idempotency_conflict');
		strictEqual(
			(await call('alice', 'POST', '', { ...input, idempotencyKey: 'import:x:1' })).body.code,
			'reserved_idempotency_key',
		);
	});

	test('a host-registered sink writes in the same transaction, and its failure rolls its write back with the memory', async () => {
		const sinkLog = async (id: string) =>
			(
				await operation({
					operation: 'search_by_id',
					database: 'memory',
					table: 'SinkLog',
					ids: [id],
					get_attributes: ['*'],
				})
			)[0];
		const memory = await create('alice', { idempotencyKey: 'sink-ok', title: 'sink', content: 'osprey dive depth' });
		strictEqual((await sinkLog(`${memory.id}:1`))?.kind, 'write');

		const failed = await call('alice', 'POST', '', {
			idempotencyKey: 'sink-fail',
			title: 'sink',
			content: 'SINK-FAIL',
		});
		strictEqual(failed.status, 500);
		deepStrictEqual(failed.body, { error: 'Internal error', code: 'internal_error' });
		const failedId = createHash('sha256').update('memory:alice:sink-fail').digest('hex').slice(0, 32);
		strictEqual(await sinkLog(`${failedId}:1`), undefined, 'the sink row rolled back');
		strictEqual((await call('alice', 'GET', failedId)).status, 404, 'the memory rolled back');
	});

	test('a host-installed principal resolver replaces identity and grants, deferring other users to next()', async () => {
		const memory = await create('erin', {
			idempotencyKey: 'resolved',
			title: 'resolved',
			content: 'agent principal memory',
			visibility: 'shared',
		});
		strictEqual(memory.ownerId, 'agent-erin');
		deepStrictEqual(memory.author.source, 'fixture-resolver');
		strictEqual((await call('alice', 'GET', memory.id)).status, 200);
		const alicePrivate = await create('alice', { idempotencyKey: 'not-for-erin', title: 'p', content: 'private' });
		strictEqual((await call('erin', 'GET', alicePrivate.id)).status, 404);
	});

	test('bootstrap: pinned, then recent, then relevant, packed into the character budget', async () => {
		const pinned = await create('bob', {
			idempotencyKey: 'pinned',
			title: 'pin',
			content: 'always load this',
			pinned: true,
			visibility: 'shared',
		});
		const recent = await create('bob', { idempotencyKey: 'recent', title: 'recent', content: 'bob was here' });
		const large = await create('bob', { idempotencyKey: 'large', title: 'large', content: 'x'.repeat(500) });
		const response = await call('bob', 'GET', 'bootstrap?budget=200');
		strictEqual(response.status, 200, JSON.stringify(response.body));
		const sections = response.body.memories.map((memory: any) => [memory.id, memory.section]);
		ok(sections.findIndex(([id]: any) => id === pinned.id) < sections.findIndex(([id]: any) => id === recent.id));
		ok(!sections.some(([id]: any) => id === large.id), 'a memory larger than the remaining budget is skipped');
		ok(response.body.used <= 200);
	});

	test('import (super_user): preserves owner and createdAt, is idempotent, and reports conflicts', async () => {
		const createdAt = '2025-01-02T03:04:05.000Z';
		const row = {
			idempotencyKey: 'import:flair:42',
			ownerId: 'alice',
			content: 'imported kestrel observation',
			scopes: ['user:alice'],
			status: 'active',
			createdAt,
		};
		strictEqual((await call('alice', 'POST', 'import', { rows: [row] })).status, 403);
		const mismatch = await call('admin', 'POST', 'import', {
			rows: [row, { ...row, idempotencyKey: 'import:flair:43', id: 'f'.repeat(32) }],
		});
		strictEqual(mismatch.status, 400);
		strictEqual(mismatch.body.code, 'import_id_mismatch');
		strictEqual(mismatch.body.index, 1);

		const first = await call('admin', 'POST', 'import', { rows: [row] });
		strictEqual(first.status, 200, JSON.stringify(first.body));
		strictEqual(first.body.results[0].result, 'created');
		const imported = (await call('alice', 'GET', first.body.results[0].id)).body.memory;
		strictEqual(imported.ownerId, 'alice');
		strictEqual(imported.createdAt, createdAt);
		strictEqual(imported.title, null);
		strictEqual((await call('bob', 'GET', imported.id)).status, 404);

		strictEqual((await call('admin', 'POST', 'import', { rows: [row] })).body.results[0].result, 'unchanged');
		strictEqual(
			(await call('admin', 'POST', 'import', { rows: [{ ...row, content: 'changed upstream' }] })).body.results[0]
				.result,
			'conflict',
		);
	});

	test("never touches the host app's own Memory table in its data database", async () => {
		await create('alice', { idempotencyKey: 'isolation', title: 'isolation', content: 'heron isolation check' });
		deepStrictEqual(
			await operation({
				operation: 'search_by_value',
				database: 'data',
				table: 'Memory',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			}),
			[],
		);
	});

	test('rejects unauthenticated requests and unknown routes', async () => {
		const anonymous = await fetch(`${ctx.harper.httpURL}/Memory/?q=anything`, {
			headers: { Accept: 'application/json' },
		});
		strictEqual(anonymous.status, 401);
		strictEqual((await call('alice', 'POST', `${'a'.repeat(32)}/explode`, {})).status, 404);
	});
});
