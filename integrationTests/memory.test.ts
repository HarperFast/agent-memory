// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { getSessionPaths } from '../claude-plugin/lib/cache.mjs';
import { resolveConfig } from '../claude-plugin/lib/config.mjs';

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

	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

	async function call(
		user: string,
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	) {
		const authorization =
			user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: authorization,
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

	const create = async (user: string, key: string, input: Record<string, unknown>) => {
		const id = memId(key);
		const response = await call(user, 'PUT', id, input);
		strictEqual(response.status, 201, JSON.stringify(response.body));
		strictEqual(response.body.id, id);
		strictEqual(response.body.revision, 1);
		const fetched = await call(user, 'GET', id);
		strictEqual(fetched.status, 200, JSON.stringify(fetched.body));
		strictEqual(fetched.etag, '"1"');
		return fetched.body.memory;
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
			config: {
				logging: { stdStreams: true },
				authentication: { authorizeLocal: false },
				mcp: { application: { mountPath: '/mcp' } },
			},
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

	test('a private memory is invisible to another user: same 404 as a missing id, 409 on PUT, absent from search', async () => {
		const memory = await create('alice', 'private-1', {
			title: 'Alice private note',
			content: 'zebra migration patterns observed in the northern valley',
		});
		deepStrictEqual(memory.scopes, ['user:alice']);
		const aliceGet = await call('alice', 'GET', memory.id);
		strictEqual(aliceGet.status, 200);
		strictEqual(aliceGet.etag, '"1"');

		const unreadable = await call('bob', 'GET', memory.id);
		const missing = await call('bob', 'GET', '0'.repeat(32));
		strictEqual(unreadable.status, 404);
		deepStrictEqual(unreadable, missing);
		deepStrictEqual(await call('bob', 'DELETE', memory.id, undefined, { 'If-Match': '"1"' }), missing);

		const putCollision = await call('bob', 'PUT', memory.id, { title: 'bob', content: 'collision' });
		strictEqual(putCollision.status, 409);
		strictEqual(putCollision.body.code, 'id_unavailable');

		ok((await search('alice', 'q=zebra')).some((hit) => hit.id === memory.id));
		deepStrictEqual(await search('bob', 'q=zebra'), []);
	});

	test('the readable set is applied inside the vector lane, before its limit', async () => {
		for (let i = 0; i < 5; i++) {
			await create('alice', `okapi-${i}`, {
				title: 'okapi',
				content: `okapi okapi okapi sighting ${i}`,
			});
		}
		const bobs = await create('bob', 'giraffe', {
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
		const denied = await call('alice', 'PUT', memId('not-allowed'), {
			title: 'nope',
			content: 'alice holds no customer grant',
			scopes: ['customer:x'],
		});
		strictEqual(denied.status, 403);
		strictEqual(denied.body.code, 'scope_not_writable');

		const memory = await create('carol', 'cx-1', {
			title: 'Customer X quirk',
			content: 'tapir replication lag appears after nightly compaction',
			scopes: ['customer:x'],
		});
		const hiddenFromY = await create('admin', 'cy-1', {
			title: 'Customer Y quirk',
			content: 'tapir caches warm slowly on customer y',
			scopes: ['customer:y'],
		});
		for (const reader of ['carol', 'dave', 'admin'])
			strictEqual((await call(reader, 'GET', memory.id)).status, 200, reader);
		for (const outsider of ['alice', 'bob'])
			strictEqual((await call(outsider, 'GET', memory.id)).status, 404, outsider);

		const nonOwnerPut = await call(
			'dave',
			'PUT',
			memory.id,
			{ title: 'dave edit', content: 'dave can read but does not own', scopes: ['customer:x'] },
			{ 'If-Match': '"1"' },
		);
		strictEqual(nonOwnerPut.status, 403);
		strictEqual(nonOwnerPut.body.code, 'not_memory_owner');

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
		const tagged = await create('alice', 'lynx-tagged', {
			title: 'lynx',
			content: 'lynx den location',
			tags: ['wildlife'],
			visibility: 'shared',
		});
		const untagged = await create('alice', 'lynx-private', {
			title: 'lynx',
			content: 'lynx den notes',
		});
		const hidden = await create('carol', 'lynx-cx', {
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
		const memory = await create('carol', 'cx-revoke', {
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
		const old = await create('alice', 'heron-v1', {
			title: 'heron threshold',
			content: 'heron alert threshold is 30 percent',
			visibility: 'shared',
		});
		const narrowing = await call('bob', 'PUT', memId('heron-narrow'), {
			title: 'heron threshold',
			content: 'heron alert threshold is 25 percent',
			supersedes: [old.id],
		});
		strictEqual(narrowing.status, 403);
		strictEqual(narrowing.body.code, 'supersede_scope_narrowing');

		const replacement = await create('bob', 'heron-v2', {
			title: 'heron threshold',
			content: 'heron alert threshold is 25 percent',
			visibility: 'shared',
			supersedes: [old.id],
		});
		const supersededGet = await call('alice', 'GET', old.id);
		strictEqual(supersededGet.etag, '"2"');
		const superseded = supersededGet.body.memory;
		strictEqual(superseded.status, 'superseded');
		strictEqual(superseded.supersededBy, replacement.id);
		strictEqual(superseded.revision, 2);

		const defaultHits = (await search('alice', 'q=heron')).map((hit) => hit.id);
		ok(defaultHits.includes(replacement.id));
		ok(!defaultHits.includes(old.id));
		ok((await search('alice', 'q=heron&includeSuperseded=true')).some((hit) => hit.id === old.id));

		const frozen = await call(
			'alice',
			'PUT',
			old.id,
			{ title: 'heron threshold', content: 'edited', visibility: 'shared' },
			{ 'If-Match': '"2"' },
		);
		strictEqual(frozen.status, 409);
		strictEqual(frozen.body.code, 'memory_superseded');

		const missingIfMatch = await call('bob', 'DELETE', `${replacement.id}?reason=wrong`);
		strictEqual(missingIfMatch.status, 428);
		strictEqual(missingIfMatch.body.code, 'if_match_required');

		const staleIfMatch = await call('bob', 'DELETE', `${replacement.id}?reason=wrong`, undefined, {
			'If-Match': '"9"',
		});
		strictEqual(staleIfMatch.status, 412);
		strictEqual(staleIfMatch.body.code, 'precondition_failed');

		const withdrawn = await call('bob', 'DELETE', `${replacement.id}?reason=wrong`, undefined, {
			'If-Match': '"1"',
		});
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		strictEqual(withdrawn.body.memory.status, 'withdrawn');
		strictEqual(withdrawn.body.memory.withdrawnReason, 'wrong');
		const restored = (await call('alice', 'GET', old.id)).body.memory;
		strictEqual(restored.status, 'active');
		strictEqual(restored.supersededBy, null);

		const afterHits = (await search('alice', 'q=heron&includeSuperseded=true')).map((hit) => hit.id);
		ok(afterHits.includes(old.id));
		ok(!afterHits.includes(replacement.id), 'withdrawn memories never appear in search');
		strictEqual((await call('alice', 'GET', replacement.id)).status, 404);
		strictEqual((await call('bob', 'GET', replacement.id)).body.memory.status, 'withdrawn');
	});

	test('concurrent revisions at the same If-Match revision: exactly one succeeds, the rest get 412 precondition_failed', async () => {
		const memory = await create('alice', 'race', { title: 'race', content: 'ibis count 3' });
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				call(
					'alice',
					'PUT',
					memory.id,
					{
						title: 'race',
						content: `ibis count ${i + 4}, embedded slowly`,
					},
					{ 'If-Match': '"1"' },
				),
			),
		);
		deepStrictEqual(
			results.map((result) => result.status).sort(),
			[200, 412, 412, 412, 412, 412, 412, 412],
			JSON.stringify(results.map((result) => result.body)),
		);
		ok(results.filter((result) => result.status === 412).every((result) => result.body.code === 'precondition_failed'));
		const after = await call('alice', 'GET', memory.id);
		strictEqual(after.body.memory.revision, 2);
		strictEqual(after.etag, '"2"');
	});

	test('concurrent withdrawals at the same If-Match revision: exactly one succeeds, the rest get 409 or 412', async () => {
		const memory = await create('alice', 'withdraw-race', { title: 'race', content: 'stork count 3' });
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				call('alice', 'DELETE', `${memory.id}?reason=duplicate`, undefined, { 'If-Match': '"1"' }),
			),
		);
		const statuses = results.map((result) => result.status).sort();
		strictEqual(statuses[0], 200, JSON.stringify(results.map((result) => result.body)));
		ok(
			statuses.slice(1).every((status) => status === 409 || status === 412),
			JSON.stringify(results.map((result) => result.body)),
		);
		strictEqual((await call('alice', 'GET', memory.id)).body.memory.revision, 2);
	});

	test('a supersede racing the withdrawal of an earlier superseder leaves the newest one in charge', async () => {
		const shared = (key: string, content: string, supersedes?: string[]) =>
			create('alice', key, { title: 'egret', content, visibility: 'shared', supersedes });
		const target = await shared('egret-t', 'egret roost one');
		const first = await shared('egret-w', 'egret roost two', [target.id]);
		const [replacement, withdrawn] = await Promise.all([
			call('alice', 'PUT', memId('egret-n'), {
				title: 'egret',
				content: 'egret roost three, embedded slowly',
				visibility: 'shared',
				supersedes: [target.id],
			}),
			call('alice', 'DELETE', first.id, undefined, { 'If-Match': '"1"' }),
		]);
		strictEqual(replacement.status, 201, JSON.stringify(replacement.body));
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		const after = (await call('alice', 'GET', target.id)).body.memory;
		strictEqual(after.status, 'superseded');
		strictEqual(after.supersededBy, replacement.body.id);
	});

	test('a create superseding both ends of a chain does not deadlock with withdrawing the middle', async () => {
		const shared = (key: string, content: string, supersedes?: string[]) =>
			create('alice', key, { title: 'plover', content, visibility: 'shared', supersedes });
		const target = await shared('plover-t', 'plover nest one');
		const middle = await shared('plover-w', 'plover nest two', [target.id]);
		const started = Date.now();
		const results = await Promise.all([
			call('alice', 'PUT', memId('plover-x'), {
				title: 'plover',
				content: 'plover nest three, embedded slowly',
				visibility: 'shared',
				supersedes: [target.id, middle.id],
			}),
			call('alice', 'DELETE', middle.id, undefined, { 'If-Match': '"1"' }),
		]);
		ok(Date.now() - started < 10_000, 'both requests finished without waiting out a lock timeout');
		// Whichever runs second sees the first one's change and is refused with 412 (stale If-Match) or 409 (withdrawn).
		const [created, withdrawn] = results.map((result) => result.status);
		ok(
			(created === 201 && withdrawn === 412) || (created === 409 && withdrawn === 200),
			JSON.stringify(results.map((result) => result.body)),
		);
	});

	test('PUT idempotency, If-None-Match: *, If-Match revise, and supersedes_not_allowed on revise', async () => {
		const id = memId('retry');
		const input = { title: 'retry', content: 'pelican nesting begins in march' };
		const first = await call('alice', 'PUT', id, input);
		const retry = await call('alice', 'PUT', id, input);
		strictEqual(first.status, 201);
		deepStrictEqual(first.body, { id, revision: 1, candidates: [] });
		strictEqual(retry.status, 200);
		deepStrictEqual(retry.body, { id, revision: 1, candidates: [] });

		const createOnly = await call('alice', 'PUT', id, input, { 'If-None-Match': '*' });
		strictEqual(createOnly.status, 412);
		strictEqual(createOnly.body.code, 'precondition_failed');

		const missingIfMatch = await call('alice', 'PUT', id, { ...input, content: 'other' });
		strictEqual(missingIfMatch.status, 428);
		strictEqual(missingIfMatch.body.code, 'if_match_required');

		const staleIfMatch = await call('alice', 'PUT', id, { ...input, content: 'other' }, { 'If-Match': '"9"' });
		strictEqual(staleIfMatch.status, 412);
		strictEqual(staleIfMatch.body.code, 'precondition_failed');

		const revised = await call('alice', 'PUT', id, { ...input, content: 'other' }, { 'If-Match': '"1"' });
		strictEqual(revised.status, 200);
		deepStrictEqual(revised.body, { id, revision: 2, candidates: [] });

		const reviseWithSupersedes = await call(
			'alice',
			'PUT',
			id,
			{ ...input, content: 'third', supersedes: [memId('other')] },
			{ 'If-Match': '"2"' },
		);
		strictEqual(reviseWithSupersedes.status, 400);
		strictEqual(reviseWithSupersedes.body.code, 'supersedes_not_allowed');
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
		const memory = await create('alice', 'sink-ok', { title: 'sink', content: 'osprey dive depth' });
		strictEqual((await sinkLog(`${memory.id}:1`))?.kind, 'write');

		const failedId = memId('sink-fail');
		const failed = await call('alice', 'PUT', failedId, {
			title: 'sink',
			content: 'SINK-FAIL',
		});
		strictEqual(failed.status, 500);
		deepStrictEqual(failed.body, { error: 'Internal error', code: 'internal_error' });
		strictEqual(await sinkLog(`${failedId}:1`), undefined, 'the sink row rolled back');
		strictEqual((await call('alice', 'GET', failedId)).status, 404, 'the memory rolled back');
	});

	test('a host-installed principal resolver replaces identity and grants, deferring other users to next()', async () => {
		const memory = await create('erin', 'resolved', {
			title: 'resolved',
			content: 'agent principal memory',
			visibility: 'shared',
		});
		strictEqual(memory.ownerId, 'agent-erin');
		deepStrictEqual(memory.author.source, 'fixture-resolver');
		strictEqual((await call('alice', 'GET', memory.id)).status, 200);
		const alicePrivate = await create('alice', 'not-for-erin', { title: 'p', content: 'private' });
		strictEqual((await call('erin', 'GET', alicePrivate.id)).status, 404);
	});

	test('bootstrap: pinned, then recent, then relevant, packed into the character budget', async () => {
		const pinned = await create('bob', 'pinned', {
			title: 'pin',
			content: 'always load this',
			visibility: 'shared',
		});
		const pinResponse = await call('bob', 'POST', `${pinned.id}/pin`, {});
		strictEqual(pinResponse.status, 200, JSON.stringify(pinResponse.body));
		strictEqual(pinResponse.body.pinned, true);
		strictEqual(pinResponse.body.memoryId, pinned.id);

		const recent = await create('bob', 'recent', { title: 'recent', content: 'bob was here' });
		const large = await create('bob', 'large', { title: 'large', content: 'x'.repeat(500) });
		const relevant = await create('alice', 'puffin', {
			title: 'puffin',
			content: 'puffin colony',
			visibility: 'shared',
		});
		const response = await call('bob', 'GET', 'bootstrap?q=puffin&budget=200');
		strictEqual(response.status, 200, JSON.stringify(response.body));
		const sections = response.body.memories.map((memory: any) => [memory.id, memory.section]);
		ok(sections.findIndex(([id]: any) => id === pinned.id) < sections.findIndex(([id]: any) => id === recent.id));
		ok(sections.some(([id, section]: any) => id === relevant.id && section === 'relevant'));
		ok(!sections.some(([id]: any) => id === large.id), 'a memory larger than the remaining budget is skipped');
		ok(response.body.memories.every((memory: any) => !('score' in memory)));
		ok(response.body.used <= 200);

		const aliceBootstrap = await call('alice', 'GET', 'bootstrap?q=puffin&budget=200');
		strictEqual(aliceBootstrap.status, 200);
		ok(
			!aliceBootstrap.body.memories.some((memory: any) => memory.id === pinned.id && memory.section === 'pinned'),
			'pins are per-reader and never leak to another principal',
		);

		const alicePrivate = await create('alice', 'alice-private-pin-target', {
			title: 'secret',
			content: 'alice private note',
		});
		const pinUnreadable = await call('bob', 'POST', `${alicePrivate.id}/pin`, {});
		const pinMissing = await call('bob', 'POST', `${'0'.repeat(32)}/pin`, {});
		strictEqual(pinUnreadable.status, 404);
		deepStrictEqual(pinUnreadable.body, pinMissing.body);

		const unpinResponse = await call('bob', 'POST', `${pinned.id}/unpin`, {});
		strictEqual(unpinResponse.status, 200);
		strictEqual(unpinResponse.body.pinned, false);
	});

	test('validUntil excludes expired memories by default and includeExpired=true restores them', async () => {
		const expired = await create('alice', 'expired-gannet', {
			title: 'expired gannet',
			content: 'gannet rookery expired note',
			validUntil: '2020-01-01T00:00:00.000Z',
		});
		const active = await create('alice', 'active-gannet', {
			title: 'active gannet',
			content: 'gannet rookery active note',
			validUntil: '2099-01-01T00:00:00.000Z',
		});
		await call('alice', 'POST', `${expired.id}/pin`, {});

		const defaultSearch = await call('alice', 'GET', '?q=gannet');
		strictEqual(defaultSearch.status, 200);
		const defaultIds = defaultSearch.body.memories.map((m: any) => m.id);
		ok(defaultIds.includes(active.id));
		ok(!defaultIds.includes(expired.id));

		const expiredSearch = await call('alice', 'GET', '?q=gannet&includeExpired=true');
		strictEqual(expiredSearch.status, 200);
		const expiredIds = expiredSearch.body.memories.map((m: any) => m.id);
		ok(expiredIds.includes(active.id));
		ok(expiredIds.includes(expired.id));

		const bootstrap = await call('alice', 'GET', 'bootstrap?q=gannet');
		strictEqual(bootstrap.status, 200);
		ok(!bootstrap.body.memories.some((m: any) => m.id === expired.id));
	});

	test('typed evidence validates readable memory refs and indexes evidenceMemoryIds', async () => {
		const source = await create('alice', 'evidence-source', {
			title: 'source',
			content: 'curlew migration observation',
			visibility: 'shared',
		});
		const bobPrivate = await create('bob', 'evidence-bob-private', {
			title: 'bob secret',
			content: 'bob private observation',
		});

		const unreadableRef = await call('alice', 'PUT', memId('evidence-unreadable'), {
			title: 'unreadable',
			content: 'citing unreadable memory',
			evidence: [{ kind: 'memory', ref: bobPrivate.id }],
		});
		const missingRef = await call('alice', 'PUT', memId('evidence-missing'), {
			title: 'missing',
			content: 'citing missing memory',
			evidence: [{ kind: 'memory', ref: '0'.repeat(32) }],
		});
		strictEqual(unreadableRef.status, 400);
		strictEqual(unreadableRef.body.code, 'invalid_evidence');
		deepStrictEqual(unreadableRef.body, missingRef.body);

		const citing = await create('alice', 'evidence-citing', {
			title: 'citing',
			content: 'curlew synthesis',
			evidence: [
				{ kind: 'memory', ref: source.id, note: 'primary observation' },
				{ kind: 'pr', ref: 'https://github.com/HarperFast/agent-memory/pull/5' },
			],
		});
		deepStrictEqual(citing.evidenceMemoryIds, [source.id]);

		const indexed = await operation({
			operation: 'search_by_value',
			database: 'memory',
			table: 'Memory',
			search_attribute: 'evidenceMemoryIds',
			search_value: source.id,
			get_attributes: ['id'],
		});
		deepStrictEqual(indexed, [{ id: citing.id }]);
	});

	// Candidate search does not wait for index coverage; a search does, so it settles the index between steps.
	const settleIndex = (user: string, q: string) => search(user, `q=${encodeURIComponent(q)}`);
	const shape = (candidates: any[]) =>
		candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied: applied ?? null }));

	test('PUT returns readable, scope-sharing candidates with a judge verdict, and acts on none in suggest mode', async () => {
		const original = await create('alice', 'grebe-v1', {
			title: 'grebe count',
			content: 'grebe colony counted at forty pairs on the north lake',
			visibility: 'shared',
		});
		await create('carol', 'grebe-cx', {
			title: 'grebe count',
			content: 'grebe colony counted at forty pairs on the north lake',
			scopes: ['customer:x'],
		});
		await settleIndex('admin', 'grebe');

		const refining = await call('bob', 'PUT', memId('grebe-v2'), {
			title: 'grebe count',
			content: 'grebe colony counted at forty pairs on the north lake EXTENDS',
			visibility: 'shared',
		});
		strictEqual(refining.status, 201, JSON.stringify(refining.body));
		deepStrictEqual(shape(refining.body.candidates), [{ id: original.id, verdict: 'refines', applied: null }]);
		const [{ similarity }] = refining.body.candidates;
		ok(similarity >= 0.82 && similarity <= 1 + 1e-6, String(similarity));
		strictEqual((await call('alice', 'GET', original.id)).body.memory.status, 'active');

		const note = await create('alice', 'grebe-note', {
			title: 'note',
			content: 'shoreline survey',
			visibility: 'shared',
		});
		await settleIndex('admin', 'grebe');
		const revised = await call(
			'alice',
			'PUT',
			note.id,
			{ content: 'grebe colony counted at forty pairs on the north lake' },
			{ 'If-Match': '"1"' },
		);
		strictEqual(revised.status, 200, JSON.stringify(revised.body));
		ok(revised.body.candidates.some((candidate: any) => candidate.id === original.id));

		const replacing = await call('bob', 'PUT', memId('grebe-v3'), {
			title: 'grebe count',
			content: 'grebe colony counted at forty pairs on the north lake REPLACES',
			visibility: 'shared',
		});
		strictEqual(replacing.status, 201, JSON.stringify(replacing.body));
		const decided = shape(replacing.body.candidates).find((candidate: any) => candidate.id === original.id);
		deepStrictEqual(decided, { id: original.id, verdict: 'supersedes', applied: null });
		strictEqual((await call('alice', 'GET', original.id)).body.memory.status, 'active');
		deepStrictEqual((await call('bob', 'GET', replacing.body.id)).body.memory.autoSupersedes, []);
	});

	test('superseding or withdrawing a memory flags its citers; search, bootstrap and confirm surface and clear the flag', async () => {
		const source = await create('alice', 'avocet-src', {
			title: 'avocet',
			content: 'avocet nesting starts in april',
			visibility: 'shared',
		});
		// customer:x, so dave (customer:*) reads it without owning it and bob cannot read it at all.
		const dependent = await create('carol', 'avocet-dep', {
			title: 'avocet plan',
			content: 'survey avocet nests in early april',
			scopes: ['customer:x'],
			evidence: [{ kind: 'memory', ref: source.id }],
		});
		const secondHop = await create('dave', 'avocet-hop', {
			title: 'avocet boat',
			content: 'book the survey boat',
			visibility: 'shared',
			evidence: [{ kind: 'memory', ref: dependent.id }],
		});
		const replacement = await create('alice', 'avocet-repl', {
			title: 'avocet',
			content: 'avocet nesting starts in may',
			visibility: 'shared',
			supersedes: [source.id],
		});

		const flagged = await call('carol', 'GET', dependent.id);
		strictEqual(flagged.etag, '"2"');
		const { since, ...flag } = flagged.body.memory.needsReview;
		deepStrictEqual(flag, { cause: 'superseded', sourceId: source.id, replacementId: replacement.id });
		ok(!Number.isNaN(Date.parse(since)));
		strictEqual((await call('dave', 'GET', secondHop.id)).body.memory.needsReview, null, 'one hop');

		const hit = (await search('carol', 'q=avocet')).find((memory) => memory.id === dependent.id);
		strictEqual(hit.needsReview.cause, 'superseded');
		const boot = await call('carol', 'GET', 'bootstrap?budget=100000');
		strictEqual(boot.status, 200, JSON.stringify(boot.body));
		ok(boot.body.memories.some((memory: any) => memory.id === dependent.id && memory.section === 'needsReview'));

		const byReader = await call('dave', 'POST', `${dependent.id}/confirm`, {});
		strictEqual(byReader.status, 403);
		strictEqual(byReader.body.code, 'not_memory_owner');
		const byNonReader = await call('bob', 'POST', `${dependent.id}/confirm`, {});
		const missing = await call('bob', 'POST', `${'0'.repeat(32)}/confirm`, {});
		strictEqual(byNonReader.status, 404);
		deepStrictEqual(byNonReader.body, missing.body);
		strictEqual((await call('carol', 'POST', `${dependent.id}/confirm`, {}, { 'If-Match': '"1"' })).status, 412);

		const confirmed = await call('carol', 'POST', `${dependent.id}/confirm`, {}, { 'If-Match': '"2"' });
		strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
		strictEqual(confirmed.body.memory.needsReview, null);
		strictEqual(confirmed.body.memory.confirmed.by, 'carol');
		strictEqual((await call('carol', 'GET', dependent.id)).etag, '"3"');
		const after = await call('carol', 'GET', 'bootstrap?budget=100000');
		ok(!after.body.memories.some((memory: any) => memory.section === 'needsReview' && memory.id === dependent.id));

		const retracted = await create('alice', 'avocet-retracted', {
			title: 'avocet',
			content: 'avocet colony uses the east island',
			visibility: 'shared',
		});
		const citer = await create('bob', 'avocet-citer', {
			title: 'avocet route',
			content: 'land on the east island',
			visibility: 'shared',
			evidence: [{ kind: 'memory', ref: retracted.id }],
		});
		strictEqual((await call('alice', 'DELETE', retracted.id, undefined, { 'If-Match': '"1"' })).status, 200);
		const withdrawnFlag = (await call('bob', 'GET', citer.id)).body.memory.needsReview;
		strictEqual(withdrawnFlag.cause, 'withdrawn');
		strictEqual(withdrawnFlag.sourceId, retracted.id);
	});

	test('a citation racing the supersede of its source is flagged, or created after the transition', async () => {
		for (let round = 0; round < 4; round++) {
			const source = await create('alice', `snipe-src-${round}`, {
				title: 'snipe',
				content: `snipe drumming display round ${round}`,
				visibility: 'shared',
			});
			const [citer, replacement] = await Promise.all([
				call('bob', 'PUT', memId(`snipe-cite-${round}`), {
					title: 'snipe plan',
					content: `listen for snipe drumming, embedded slowly ${round}`,
					visibility: 'shared',
					evidence: [{ kind: 'memory', ref: source.id }],
				}),
				call('alice', 'PUT', memId(`snipe-repl-${round}`), {
					title: 'snipe',
					content: `snipe drumming display moved, round ${round}, embedded slowly`,
					visibility: 'shared',
					supersedes: [source.id],
				}),
			]);
			strictEqual(citer.status, 201, JSON.stringify(citer.body));
			strictEqual(replacement.status, 201, JSON.stringify(replacement.body));
			const cited = (await call('bob', 'GET', citer.body.id)).body.memory;
			const superseded = (await call('alice', 'GET', source.id)).body.memory;
			strictEqual(superseded.status, 'superseded');
			ok(cited.needsReview !== null || cited.createdAt >= superseded.updatedAt, JSON.stringify({ cited, superseded }));
		}
	});

	test('import (super_user): preserves client id, owner and createdAt, is idempotent, and reports conflicts', async () => {
		const createdAt = '2025-01-02T03:04:05.000Z';
		const flairId = createHash('sha256').update('flair:42').digest('hex').slice(0, 32);
		const row = {
			id: flairId,
			ownerId: 'alice',
			content: 'imported kestrel observation',
			scopes: ['user:alice'],
			status: 'active',
			createdAt,
		};
		strictEqual((await call('alice', 'POST', 'import', { rows: [row] })).status, 403);
		const invalidId = await call('admin', 'POST', 'import', {
			rows: [row, { ...row, id: 'short' }],
		});
		strictEqual(invalidId.status, 400);
		strictEqual(invalidId.body.code, 'invalid_id');
		strictEqual(invalidId.body.index, 1);

		const first = await call('admin', 'POST', 'import', { rows: [row] });
		strictEqual(first.status, 200, JSON.stringify(first.body));
		strictEqual(first.body.results[0].result, 'created');
		strictEqual(first.body.results[0].id, flairId);
		const imported = (await call('alice', 'GET', flairId)).body.memory;
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
		await create('alice', 'isolation', { title: 'isolation', content: 'heron isolation check' });
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

	test('Harper rejects a vector query of another size with 400, which the full-text fallback relies on', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/MismatchProbe/`, {
			headers: {
				Authorization: basic(ctx.harper.admin.username, ctx.harper.admin.password),
				Accept: 'application/json',
			},
		});
		deepStrictEqual(await response.json(), { statusCode: 400, startsWithSearchTarget: true });
	});

	test('transient embedding failure returns 503 on write and degrades search and bootstrap to full-text', async () => {
		const stored = await create('alice', 'bittern-ok', {
			title: 'bittern',
			content: 'bittern reedbed observation',
			visibility: 'shared',
		});
		const failedId = memId('embed-fail');
		const failedWrite = await call('alice', 'PUT', failedId, {
			title: 'bittern',
			content: 'EMBED-FAIL bittern write',
		});
		strictEqual(failedWrite.status, 503, JSON.stringify(failedWrite.body));
		strictEqual(failedWrite.body.code, 'unavailable');
		strictEqual((await call('alice', 'GET', failedId)).status, 404);

		const searched = await call('alice', 'GET', '?q=EMBED-FAIL%20bittern');
		strictEqual(searched.status, 200, JSON.stringify(searched.body));
		ok(searched.body.memories.some((m: any) => m.id === stored.id));

		const boot = await call('alice', 'GET', 'bootstrap?q=EMBED-FAIL%20bittern');
		strictEqual(boot.status, 200, JSON.stringify(boot.body));
		ok(boot.body.memories.some((m: any) => m.id === stored.id));
	});

	test('rejects unauthenticated requests, removed POST routes, and unknown routes', async () => {
		const anonymous = await fetch(`${ctx.harper.httpURL}/Memory/?q=anything`, {
			headers: { Accept: 'application/json' },
		});
		strictEqual(anonymous.status, 401);
		const id = 'a'.repeat(32);
		const postRoot = await call('alice', 'POST', '', { title: 'x', content: 'y' });
		strictEqual(postRoot.status, 405);
		strictEqual((await call('alice', 'POST', `${id}/revise`, {})).status, 404);
		strictEqual((await call('alice', 'POST', `${id}/scopes`, {})).status, 404);
		strictEqual((await call('alice', 'POST', `${id}/withdraw`, {})).status, 404);
		strictEqual((await call('alice', 'POST', `${id}/explode`, {})).status, 404);
	});

	async function openSSE(user: string, urlPath: string, extraHeaders: Record<string, string> = {}) {
		const authorization =
			user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		const controller = new AbortController();
		const response = await fetch(`${ctx.harper.httpURL}${urlPath}`, {
			headers: {
				Accept: 'text/event-stream',
				Authorization: authorization,
				...extraHeaders,
			},
			signal: controller.signal,
		});
		const events: any[] = [];
		const waiters: Array<() => void> = [];
		if (response.ok && response.body) {
			const reader = response.body.getReader();
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
							if (line.startsWith('data:')) {
								const raw = line.slice(5).trim();
								if (!raw) continue;
								try {
									events.push(JSON.parse(raw));
									for (const notify of waiters.splice(0)) notify();
								} catch {
									// Ignore non-JSON frames.
								}
							}
						}
					}
				} catch {
					// Aborted when test closes SSE stream.
				}
			})();
		}
		return {
			status: response.status,
			events,
			async waitFor(predicate: (event: any) => boolean, timeoutMs = 10_000): Promise<any> {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const match = events.find(predicate);
					if (match) return match;
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 100);
						waiters.push(() => {
							clearTimeout(timer);
							resolve();
						});
					});
				}
				throw new Error(`Timed out waiting for SSE event; received: ${JSON.stringify(events)}`);
			},
			close() {
				controller.abort();
			},
		};
	}

	test('Level 1 SSE subscriptions deliver record-change events without content and enforce read rules at delivery time', async () => {
		const alicePrivate = await create('alice', 'sse-priv', {
			title: 'secret',
			content: 'alice private sse note',
		});
		const unauthSub = await openSSE('bob', `/Memory/${alicePrivate.id}`);
		const missingSub = await openSSE('bob', `/Memory/${'0'.repeat(32)}`);
		strictEqual(unauthSub.status, 404);
		strictEqual(missingSub.status, 404);
		unauthSub.close();
		missingSub.close();

		const aliceAll = await openSSE('alice', '/Memory/');
		const bobAll = await openSSE('bob', '/Memory/');
		const daveAll = await openSSE('dave', '/Memory/');
		strictEqual(aliceAll.status, 200);
		strictEqual(bobAll.status, 200);
		strictEqual(daveAll.status, 200);

		try {
			const shared = await create('alice', 'sse-shared', {
				title: 'tern',
				content: 'tern migration started',
				visibility: 'shared',
			});
			const singleSub = await openSSE('bob', `/Memory/${shared.id}`);
			strictEqual(singleSub.status, 200);

			try {
				const createdEvt = await bobAll.waitFor((e) => e.id === shared.id && e.kind === 'created');
				deepStrictEqual(createdEvt, { id: shared.id, kind: 'created', revision: 1 });
				ok(!('content' in createdEvt) && !('title' in createdEvt));

				// Revise shared memory -> bob receives revised on both /Memory/ and /Memory/<id>
				const rev = await call(
					'alice',
					'PUT',
					shared.id,
					{ title: 'tern', content: 'tern migration updated', visibility: 'shared' },
					{ 'If-Match': '"1"' },
				);
				strictEqual(rev.status, 200);
				deepStrictEqual(await singleSub.waitFor((e) => e.id === shared.id && e.kind === 'revised'), {
					id: shared.id,
					kind: 'revised',
					revision: 2,
				});

				// Narrow scope to private -> bob must NOT receive the revision event (mid-subscription revocation)
				const narrowed = await call(
					'alice',
					'PUT',
					shared.id,
					{ title: 'tern', content: 'now private to alice', visibility: 'private' },
					{ 'If-Match': '"2"' },
				);
				strictEqual(narrowed.status, 200);
				deepStrictEqual(await aliceAll.waitFor((e) => e.id === shared.id && e.revision === 3), {
					id: shared.id,
					kind: 'revised',
					revision: 3,
				});

				// Widen back to shared, cite from bob, supersede, and withdraw superseder to exercise
				// flagged, superseded, restored, and withdrawn events.
				strictEqual(
					(
						await call(
							'alice',
							'PUT',
							shared.id,
							{ title: 'tern', content: 'shared again', visibility: 'shared' },
							{ 'If-Match': '"3"' },
						)
					).status,
					200,
				);
				await bobAll.waitFor((e) => e.id === shared.id && e.revision === 4);
				await singleSub.waitFor((e) => e.id === shared.id && e.revision === 4);
				ok(!bobAll.events.some((e) => e.id === shared.id && e.revision === 3));
				ok(!singleSub.events.some((e) => e.id === shared.id && e.revision === 3));

				const citer = await create('bob', 'sse-citer', {
					title: 'tern plan',
					content: 'follow tern migration',
					visibility: 'shared',
					evidence: [{ kind: 'memory', ref: shared.id }],
				});
				const replacement = await create('alice', 'sse-repl', {
					title: 'tern',
					content: 'tern migration moved south',
					visibility: 'shared',
					supersedes: [shared.id],
				});
				deepStrictEqual(await singleSub.waitFor((e) => e.id === shared.id && e.kind === 'superseded'), {
					id: shared.id,
					kind: 'superseded',
					revision: 5,
				});
				deepStrictEqual(await bobAll.waitFor((e) => e.id === citer.id && e.kind === 'flagged'), {
					id: citer.id,
					kind: 'flagged',
					revision: 2,
				});

				// Withdraw shared replacement -> both alice (owner) and bob (label reader) receive withdrawn for replacement,
				// and restored on shared.id; withdrawing alicePrivate delivers withdrawn to alice only, not bob.
				strictEqual((await call('alice', 'DELETE', replacement.id, undefined, { 'If-Match': '"1"' })).status, 200);
				strictEqual((await call('alice', 'DELETE', alicePrivate.id, undefined, { 'If-Match': '"1"' })).status, 200);
				deepStrictEqual(await aliceAll.waitFor((e) => e.id === replacement.id && e.kind === 'withdrawn'), {
					id: replacement.id,
					kind: 'withdrawn',
					revision: 2,
				});
				deepStrictEqual(await aliceAll.waitFor((e) => e.id === alicePrivate.id && e.kind === 'withdrawn'), {
					id: alicePrivate.id,
					kind: 'withdrawn',
					revision: 2,
				});
				deepStrictEqual(await bobAll.waitFor((e) => e.id === replacement.id && e.kind === 'withdrawn'), {
					id: replacement.id,
					kind: 'withdrawn',
					revision: 2,
				});
				deepStrictEqual(await singleSub.waitFor((e) => e.id === shared.id && e.kind === 'restored'), {
					id: shared.id,
					kind: 'restored',
					revision: 6,
				});

				// ScopeGrant revocation mid-subscription: dave loses customer:* and no longer receives customer:x events.
				const cxMem = await create('carol', 'sse-cx', {
					title: 'cx',
					content: 'customer x event',
					scopes: ['customer:x'],
				});
				await daveAll.waitFor((e) => e.id === cxMem.id && e.kind === 'created');
				await operation({ operation: 'delete', database: 'memory', table: 'ScopeGrant', ids: ['user:dave'] });
				try {
					strictEqual(
						(
							await call(
								'carol',
								'PUT',
								cxMem.id,
								{ title: 'cx', content: 'after dave grant revoked', scopes: ['customer:x'] },
								{ 'If-Match': '"1"' },
							)
						).status,
						200,
					);
					const marker = await create('alice', 'sse-marker', {
						title: 'marker',
						content: 'shared marker after cx update',
						visibility: 'shared',
					});
					await daveAll.waitFor((e) => e.id === marker.id && e.kind === 'created');
					await bobAll.waitFor((e) => e.id === marker.id && e.kind === 'created');
					ok(!daveAll.events.some((e) => e.id === cxMem.id && e.revision === 2));
					ok(!bobAll.events.some((e) => e.id === alicePrivate.id));
				} finally {
					await operation({
						operation: 'upsert',
						database: 'memory',
						table: 'ScopeGrant',
						records: [{ id: 'user:dave', read: ['customer:*'] }],
					});
				}
			} finally {
				singleSub.close();
			}
		} finally {
			aliceAll.close();
			bobAll.close();
			daveAll.close();
		}
	});

	test('Level 2 watches: POST /Memory/watch, watch=true on search and bootstrap, and /MemoryEvents stream', async () => {
		const alicePriv = await create('alice', 'watch-priv', {
			title: 'secret',
			content: 'alice private watch target',
		});
		const watchUnreadable = await call('bob', 'POST', 'watch', { ids: [alicePriv.id] });
		const watchMissing = await call('bob', 'POST', 'watch', { ids: ['0'.repeat(32)] });
		strictEqual(watchUnreadable.status, 404);
		deepStrictEqual(watchUnreadable.body, watchMissing.body);

		// /MemoryEvents rejects principal in path
		const withPath = await openSSE('bob', '/MemoryEvents/bob');
		strictEqual(withPath.status, 404);
		withPath.close();

		const watchedMem = await create('alice', 'watch-shared-1', {
			title: 'albatross',
			content: 'albatross wingspan measurement',
			visibility: 'shared',
		});
		const searchWatched = await create('alice', 'watch-search-target', {
			title: 'frigatebird',
			content: 'frigatebird thermal soaring altitude',
			visibility: 'shared',
		});
		const bootWatched = await create('bob', 'watch-boot-target', {
			title: 'skua',
			content: 'skua nesting territory',
			visibility: 'shared',
		});

		const explicitWatch = await call('bob', 'POST', 'watch', { ids: [watchedMem.id], ttlSeconds: 7200 });
		strictEqual(explicitWatch.status, 200, JSON.stringify(explicitWatch.body));
		deepStrictEqual(explicitWatch.body.watched, [watchedMem.id]);
		const initialExpiry = Date.parse(explicitWatch.body.expiresAt);
		ok(!Number.isNaN(initialExpiry));

		// A shorter TTL request must not shorten the existing 7200 s watch.
		const shorterWatch = await call('bob', 'POST', 'watch', { ids: [watchedMem.id], ttlSeconds: 60 });
		strictEqual(shorterWatch.status, 200);
		strictEqual(Date.parse(shorterWatch.body.expiresAt), initialExpiry);

		const searchRes = await call('bob', 'GET', '?q=frigatebird&watch=true');
		strictEqual(searchRes.status, 200);
		ok(searchRes.body.memories.some((m: any) => m.id === searchWatched.id));

		const bootRes = await call('bob', 'GET', 'bootstrap?q=skua&watch=true');
		strictEqual(bootRes.status, 200);
		ok(bootRes.body.memories.some((m: any) => m.id === bootWatched.id));

		// Created after bootstrap?watch=true so bootstrap's recent section does not watch them.
		const unwatchedMem = await create('alice', 'watch-shared-2', {
			title: 'petrel',
			content: 'petrel burrow count',
			visibility: 'shared',
		});
		const bobCiter = await create('bob', 'watch-bob-citer', {
			title: 'unwatched citer',
			content: 'cites unwatchedMem so bob gets flagged event even without watching bobCiter',
			visibility: 'shared',
			evidence: [{ kind: 'memory', ref: unwatchedMem.id }],
		});

		const bobEvents = await openSSE('bob', '/MemoryEvents');
		strictEqual(bobEvents.status, 200);
		try {
			// Revise unwatchedMem -> bob should NOT receive it
			strictEqual(
				(
					await call(
						'alice',
						'PUT',
						unwatchedMem.id,
						{ title: 'petrel', content: 'petrel burrow count updated', visibility: 'shared' },
						{ 'If-Match': '"1"' },
					)
				).status,
				200,
			);
			// Revise watchedMem, searchWatched, bootWatched -> bob receives all three
			strictEqual(
				(
					await call(
						'alice',
						'PUT',
						watchedMem.id,
						{ title: 'albatross', content: 'albatross updated', visibility: 'shared' },
						{ 'If-Match': '"1"' },
					)
				).status,
				200,
			);
			strictEqual(
				(
					await call(
						'alice',
						'PUT',
						searchWatched.id,
						{ title: 'frigatebird', content: 'frigatebird updated', visibility: 'shared' },
						{ 'If-Match': '"1"' },
					)
				).status,
				200,
			);
			strictEqual(
				(
					await call(
						'bob',
						'PUT',
						bootWatched.id,
						{ title: 'skua', content: 'skua updated', visibility: 'shared' },
						{ 'If-Match': '"1"' },
					)
				).status,
				200,
			);

			await bobEvents.waitFor((e) => e.id === watchedMem.id && e.kind === 'revised');
			await bobEvents.waitFor((e) => e.id === searchWatched.id && e.kind === 'revised');
			await bobEvents.waitFor((e) => e.id === bootWatched.id && e.kind === 'revised');
			ok(!bobEvents.events.some((e) => e.id === unwatchedMem.id));

			// Withdraw watchedMem -> bob receives 'withdrawn' for the watched shared memory
			strictEqual((await call('alice', 'DELETE', watchedMem.id, undefined, { 'If-Match': '"2"' })).status, 200);
			deepStrictEqual(await bobEvents.waitFor((e) => e.id === watchedMem.id && e.kind === 'withdrawn'), {
				id: watchedMem.id,
				kind: 'withdrawn',
				revision: 3,
			});

			// Withdraw unwatchedMem -> flags bobCiter (owned by bob), so bob receives flagged on /MemoryEvents
			strictEqual((await call('alice', 'DELETE', unwatchedMem.id, undefined, { 'If-Match': '"2"' })).status, 200);
			deepStrictEqual(await bobEvents.waitFor((e) => e.id === bobCiter.id && e.kind === 'flagged'), {
				id: bobCiter.id,
				kind: 'flagged',
				revision: 2,
			});
		} finally {
			bobEvents.close();
		}
	});

	async function mcpCall(
		user: string | null,
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		extraHeaders: Record<string, string> = {},
	) {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			...extraHeaders,
		};
		if (user !== null) {
			headers.Authorization =
				user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		}
		if (sessionId) {
			headers['Mcp-Session-Id'] = sessionId;
			headers['MCP-Protocol-Version'] = '2025-06-18';
		}
		const response = await fetch(`${ctx.harper.httpURL}/mcp`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		return {
			status: response.status,
			sessionId: response.headers.get('mcp-session-id') ?? undefined,
			body: parsed,
		};
	}

	async function initMcpSession(user: string | null, extraHeaders: Record<string, string> = {}) {
		const init = await mcpCall(
			user,
			'initialize',
			{
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'memory-integration-test', version: '1.0.0' },
			},
			undefined,
			extraHeaders,
		);
		strictEqual(init.status, 200, JSON.stringify(init.body));
		ok(init.sessionId, 'MCP initialize must return Mcp-Session-Id');
		return init.sessionId!;
	}

	test('MCP endpoint exposes the 9 memory tools and memory:///{id} resource template, and enforces lifecycle rules', async () => {
		const aliceSession = await initMcpSession('alice');
		const bobSession = await initMcpSession('bob');

		const toolsRes = await mcpCall('alice', 'tools/list', {}, aliceSession);
		strictEqual(toolsRes.status, 200, JSON.stringify(toolsRes.body));
		const allToolNames: string[] = toolsRes.body.result.tools.map((t: any) => t.name).sort();
		ok(
			!allToolNames.some((n) => n.endsWith('_Memory') || n.endsWith('_MemoryEvents') || n.endsWith('_MemoryMcp')),
			`no generic table/resource tools should be auto-generated for Memory, MemoryEvents, or MemoryMcp: ${JSON.stringify(allToolNames)}`,
		);
		const toolNames = allToolNames.filter((n) => n !== 'get_MismatchProbe');
		deepStrictEqual(
			toolNames,
			['confirm', 'get', 'pin', 'recall', 'remember', 'revise', 'unpin', 'watch', 'withdraw'],
			`unexpected MCP tools: ${JSON.stringify(toolNames)}`,
		);

		const templatesRes = await mcpCall('alice', 'resources/templates/list', {}, aliceSession);
		strictEqual(templatesRes.status, 200, JSON.stringify(templatesRes.body));
		const uris: string[] = templatesRes.body.result.resourceTemplates.map((t: any) => t.uriTemplate);
		ok(uris.includes('memory:///{id}'), `expected memory:///{id} in resourceTemplates: ${JSON.stringify(uris)}`);

		// remember (create)
		const rememberId = memId('mcp-rem-1');
		const rememberRes = await mcpCall(
			'alice',
			'tools/call',
			{
				name: 'remember',
				arguments: {
					id: rememberId,
					title: 'mcp osprey',
					content: 'osprey sighted via mcp remember tool',
					visibility: 'shared',
				},
			},
			aliceSession,
		);
		strictEqual(rememberRes.status, 200, JSON.stringify(rememberRes.body));
		ok(!rememberRes.body.result.isError, JSON.stringify(rememberRes.body));
		const created = JSON.parse(rememberRes.body.result.content[0].text);
		strictEqual(created.id, rememberId);
		strictEqual(created.revision, 1);

		// revise
		const reviseRes = await mcpCall(
			'alice',
			'tools/call',
			{
				name: 'revise',
				arguments: {
					id: rememberId,
					revision: 1,
					title: 'mcp osprey',
					content: 'osprey sighted twice via mcp revise tool',
					visibility: 'shared',
				},
			},
			aliceSession,
		);
		const revised = JSON.parse(reviseRes.body.result.content[0].text);
		strictEqual(revised.revision, 2);

		// get & resources/read
		const getRes = await mcpCall('bob', 'tools/call', { name: 'get', arguments: { id: rememberId } }, bobSession);
		strictEqual(JSON.parse(getRes.body.result.content[0].text).memory.revision, 2);

		const readRes = await mcpCall('bob', 'resources/read', { uri: `memory:///${rememberId}` }, bobSession);
		strictEqual(readRes.status, 200, JSON.stringify(readRes.body));
		strictEqual(JSON.parse(readRes.body.result.contents[0].text).revision, 2);

		// Unreadable memory over MCP get and resources/read
		const aliceSecretId = memId('mcp-secret');
		await mcpCall(
			'alice',
			'tools/call',
			{
				name: 'remember',
				arguments: { id: aliceSecretId, title: 'secret', content: 'private mcp note', visibility: 'private' },
			},
			aliceSession,
		);
		const bobGetSecret = await mcpCall(
			'bob',
			'tools/call',
			{ name: 'get', arguments: { id: aliceSecretId } },
			bobSession,
		);
		strictEqual(bobGetSecret.body.result.isError, true);
		const bobReadSecret = await mcpCall('bob', 'resources/read', { uri: `memory:///${aliceSecretId}` }, bobSession);
		ok(bobReadSecret.body.error, 'resources/read on unreadable memory must return JSON-RPC error');

		// pin, unpin, watch, recall (with watch: true)
		const pinRes = await mcpCall('bob', 'tools/call', { name: 'pin', arguments: { id: rememberId } }, bobSession);
		strictEqual(JSON.parse(pinRes.body.result.content[0].text).pinned, true);
		const unpinRes = await mcpCall('bob', 'tools/call', { name: 'unpin', arguments: { id: rememberId } }, bobSession);
		strictEqual(JSON.parse(unpinRes.body.result.content[0].text).pinned, false);

		const watchRes = await mcpCall(
			'bob',
			'tools/call',
			{ name: 'watch', arguments: { ids: [rememberId], ttlSeconds: 120 } },
			bobSession,
		);
		deepStrictEqual(JSON.parse(watchRes.body.result.content[0].text).watched, [rememberId]);

		const recallRes = await mcpCall(
			'bob',
			'tools/call',
			{ name: 'recall', arguments: { q: 'osprey', watch: true } },
			bobSession,
		);
		ok(JSON.parse(recallRes.body.result.content[0].text).memories.some((m: any) => m.id === rememberId));

		// cite, withdraw source -> confirm citer
		const citerId = memId('mcp-citer');
		await mcpCall(
			'bob',
			'tools/call',
			{
				name: 'remember',
				arguments: {
					id: citerId,
					title: 'osprey report',
					content: 'cites osprey observation',
					visibility: 'shared',
					evidence: [{ kind: 'memory', ref: rememberId }],
				},
			},
			bobSession,
		);
		const withdrawRes = await mcpCall(
			'alice',
			'tools/call',
			{ name: 'withdraw', arguments: { id: rememberId, revision: 2, reason: 'retracted' } },
			aliceSession,
		);
		strictEqual(JSON.parse(withdrawRes.body.result.content[0].text).memory.status, 'withdrawn');

		const confirmRes = await mcpCall(
			'bob',
			'tools/call',
			{ name: 'confirm', arguments: { id: citerId, revision: 2 } },
			bobSession,
		);
		strictEqual(JSON.parse(confirmRes.body.result.content[0].text).memory.needsReview, null);

		// Verify Harper core gap on resources/subscribe for custom URI scheme (HarperFast/harper#3250)
		const mcpSse = await openSSE('alice', '/mcp', { 'Mcp-Session-Id': aliceSession });
		strictEqual(mcpSse.status, 200);
		try {
			const subRes = await mcpCall('alice', 'resources/subscribe', { uri: `memory:///${aliceSecretId}` }, aliceSession);
			strictEqual(subRes.body.error?.code, -32602);
			ok(
				String(subRes.body.error?.message).includes('resource is not subscribable'),
				`unexpected subscribe error: ${JSON.stringify(subRes.body)}`,
			);
		} finally {
			mcpSse.close();
		}
	});

	test('verifies @harperfast/oauth MCP composition against Harper core /mcp (HarperFast/oauth#279)', async () => {
		// Positive control: prove the `server.http` hook runs on `/mcp` and succeeds when it populates a
		// Harper user object (`{ username: 'alice' }`) on `request.user`.
		const hydratedHeaders = { 'x-simulate-oauth-mcp': 'oauth-hydrated-user' };
		const session0 = await initMcpSession(null, hydratedHeaders);
		const call0 = await mcpCall(
			null,
			'tools/call',
			{ name: 'recall', arguments: { q: 'osprey' } },
			session0,
			hydratedHeaders,
		);
		strictEqual(call0.body.result.isError, undefined, JSON.stringify(call0.body));
		ok(Array.isArray(JSON.parse(call0.body.result.content[0].text).memories));

		// 1. `withMCPAuth` sets `request._oauthAuth = { valid: true, userId: 'alice', ... }` and leaves `request.user` undefined.
		// Harper core's /mcp adapter reads `request.user`, so `context.user` is undefined and tool calls fail auth.
		const withMcpAuthHeaders = { 'x-simulate-oauth-mcp': 'with-mcp-auth' };
		const session1 = await initMcpSession(null, withMcpAuthHeaders);
		const call1 = await mcpCall(
			null,
			'tools/call',
			{ name: 'recall', arguments: { q: 'anything' } },
			session1,
			withMcpAuthHeaders,
		);
		strictEqual(call1.body.result.isError, true);
		ok(String(call1.body.result.content[0].text).includes('Authenticated principal required'));

		// 2. `@harperfast/oauth`'s global HTTP hook sets `request.user = payload.username` (a bare string).
		// Harper core's /mcp passes `userObject: 'alice'` into `context.user`, which fails `resolvePrincipal`
		// because `resolveHarperUser` requires a user object with `typeof user.username === 'string'`.
		const oauthHookHeaders = { 'x-simulate-oauth-mcp': 'oauth-resource-string-user' };
		const session2 = await initMcpSession(null, oauthHookHeaders);
		const noteId = memId('oauth-hook-note');
		const call2 = await mcpCall(
			null,
			'tools/call',
			{ name: 'remember', arguments: { id: noteId, title: 'oauth note', content: 'created as alice' } },
			session2,
			oauthHookHeaders,
		);
		strictEqual(call2.body.result.isError, true);
		ok(String(call2.body.result.content[0].text).includes('Authenticated principal required'));
	});

	function execNodeScript(scriptPath: string, args: string[], stdinText: string, env: Record<string, string>) {
		return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
			const child = spawn(process.execPath, [scriptPath, ...args], {
				env: { ...process.env, ...env },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk.toString('utf8');
			});
			child.on('error', rejectPromise);
			child.on('close', (code) => {
				resolvePromise({ code, stdout, stderr });
			});
			if (stdinText) {
				child.stdin.write(stdinText);
			}
			child.stdin.end();
		});
	}

	test('claude-plugin hooks, /MemoryEvents follower, import-claude-memory.mjs, and eval-recall.mjs end-to-end', async () => {
		const repoRoot = resolve(import.meta.dirname, '..');
		const hookScript = join(repoRoot, 'claude-plugin', 'hooks', 'hook.mjs');
		const headersScript = join(repoRoot, 'claude-plugin', 'bin', 'headers.mjs');
		const importScript = join(repoRoot, 'scripts', 'import-claude-memory.mjs');
		const evalScript = join(repoRoot, 'scripts', 'eval-recall.mjs');

		const tmpDir = mkdtempSync(join(tmpdir(), 'agent-memory-claude-e2e-'));
		const cacheDir = join(tmpDir, 'cache');
		const sessionId = 'e2e-claude-session-1';
		const bobEnv: Record<string, string> = {
			AGENT_MEMORY_URL: ctx.harper.httpURL,
			AGENT_MEMORY_TOKEN: basic('bob', PASSWORD),
			AGENT_MEMORY_USER: 'bob',
			AGENT_MEMORY_CACHE_DIR: cacheDir,
			AGENT_MEMORY_HEARTBEAT_MS: '100',
		};
		const { lockFile, eventsFile } = getSessionPaths(resolveConfig(bobEnv), sessionId);

		try {
			const headersRes = await execNodeScript(headersScript, [], '', bobEnv);
			strictEqual(headersRes.code, 0, headersRes.stderr);
			const mcpHeaders = JSON.parse(headersRes.stdout);
			strictEqual(mcpHeaders.Authorization, basic('bob', PASSWORD));

			const bobPinned = await create('bob', 'e2e-bob-pinned', {
				title: 'Pinned curlew invariant',
				content: 'curlew telemetry must include ring number',
			});
			strictEqual((await call('bob', 'POST', `${bobPinned.id}/pin`, {})).status, 200);

			const aliceShared = await create('alice', 'e2e-alice-shared', {
				title: 'turnstone tide table',
				content: 'turnstone foraging peaks two hours before low tide',
				visibility: 'shared',
			});
			const bobCiter = await create('bob', 'e2e-bob-citer', {
				title: 'turnstone camera setup',
				content: 'deploy camera two hours before low tide per turnstone table',
				visibility: 'shared',
				evidence: [{ kind: 'memory', ref: aliceShared.id }],
			});
			await settleIndex('bob', 'turnstone');

			const bootHook = await execNodeScript(
				hookScript,
				[],
				JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' }),
				bobEnv,
			);
			strictEqual(bootHook.code, 0, bootHook.stderr);
			const bootOut = JSON.parse(bootHook.stdout);
			const bootContext: string = bootOut.hookSpecificOutput.additionalContext;
			ok(bootContext.includes(bobPinned.id), `expected pinned memory in bootstrap context: ${bootContext}`);
			ok(bootContext.includes('author="bob"'));
			ok(bootContext.includes('scopes="user:bob"'));
			ok(bootContext.includes('needsReview="false"'));

			let followerConnected = false;
			const lockDeadline = Date.now() + 3000;
			while (Date.now() < lockDeadline) {
				if (existsSync(lockFile)) {
					try {
						const lockData = JSON.parse(readFileSync(lockFile, 'utf8'));
						if (lockData.connected) {
							followerConnected = true;
							break;
						}
					} catch {}
				}
				await new Promise((r) => setTimeout(r, 40));
			}
			ok(followerConnected, `expected follower to connect and write lockFile ${lockFile}`);

			const recallHook1 = await execNodeScript(
				hookScript,
				[],
				JSON.stringify({
					hook_event_name: 'UserPromptSubmit',
					session_id: sessionId,
					prompt: 'turnstone foraging low tide',
				}),
				bobEnv,
			);
			strictEqual(recallHook1.code, 0, recallHook1.stderr);
			const recallOut1 = JSON.parse(recallHook1.stdout);
			const recallContext1: string = recallOut1.hookSpecificOutput?.additionalContext ?? '';
			if (!bootContext.includes(aliceShared.id)) {
				ok(recallContext1.includes(aliceShared.id), `expected ${aliceShared.id} in recall output`);
			}

			const recallHookDup = await execNodeScript(
				hookScript,
				[],
				JSON.stringify({
					hook_event_name: 'UserPromptSubmit',
					session_id: sessionId,
					prompt: 'turnstone foraging low tide',
				}),
				bobEnv,
			);
			strictEqual(recallHookDup.code, 0);
			strictEqual(recallHookDup.stdout.trim(), '{}', 'already-injected memories must not be re-injected');

			strictEqual((await call('alice', 'DELETE', aliceShared.id, undefined, { 'If-Match': '"1"' })).status, 200);

			let eventsArrived = false;
			const eventDeadline = Date.now() + 3000;
			while (Date.now() < eventDeadline) {
				if (existsSync(eventsFile)) {
					const content = readFileSync(eventsFile, 'utf8');
					if (content.includes(aliceShared.id) && content.includes(bobCiter.id)) {
						eventsArrived = true;
						break;
					}
				}
				await new Promise((r) => setTimeout(r, 40));
			}
			ok(eventsArrived, `expected follower events for ${aliceShared.id} and ${bobCiter.id} in ${eventsFile}`);

			const noticeHook = await execNodeScript(
				hookScript,
				[],
				JSON.stringify({
					hook_event_name: 'UserPromptSubmit',
					session_id: sessionId,
					prompt: 'unrelated query xyz123',
				}),
				bobEnv,
			);
			strictEqual(noticeHook.code, 0, noticeHook.stderr);
			const noticeContext: string = JSON.parse(noticeHook.stdout).hookSpecificOutput?.additionalContext ?? '';
			ok(
				noticeContext.includes(`id="${aliceShared.id}" change="withdrawn"`),
				`expected withdrawn notice for ${aliceShared.id}: ${noticeContext}`,
			);
			ok(
				noticeContext.includes(`id="${bobCiter.id}" change="flagged"`),
				`expected flagged notice for ${bobCiter.id}: ${noticeContext}`,
			);

			const memDir = join(tmpDir, 'claude-memory');
			mkdirSync(memDir, { recursive: true });
			writeFileSync(join(memDir, 'MEMORY.md'), '# Index\n- [Redshank](redshank.md)\n- [Greenshank](greenshank.md)\n');
			writeFileSync(
				join(memDir, 'redshank.md'),
				[
					'---',
					'name: Redshank protocol',
					'description: Redshank banding rule referencing [[Greenshank reference]]',
					'type: feedback',
					'---',
					'Always band redshanks on the right tibia.',
					'',
					'**Why:** Left tibia bands interfere with salt-gland sensor tags.',
					'**How to apply:** Check sensor placement before banding.',
				].join('\n'),
			);
			writeFileSync(
				join(memDir, 'greenshank.md'),
				[
					'---',
					'name: Greenshank reference',
					'description: Greenshank estuary coordinates',
					'type: reference',
					'---',
					'Greenshank roost is at sector 7G.',
				].join('\n'),
			);

			const importRes = await execNodeScript(importScript, ['--json', memDir], '', bobEnv);
			strictEqual(importRes.code, 0, importRes.stderr);
			const imported = JSON.parse(importRes.stdout);
			strictEqual(imported.count, 2, 'MEMORY.md index must be skipped');

			const redshankRec = imported.records.find((r: any) => r.name === 'Redshank protocol');
			const greenshankRec = imported.records.find((r: any) => r.name === 'Greenshank reference');
			ok(redshankRec && greenshankRec);

			const storedRedshank = (await call('bob', 'GET', redshankRec.id)).body.memory;
			strictEqual(storedRedshank.ownerId, 'bob');
			deepStrictEqual(storedRedshank.scopes, ['user:bob']);
			deepStrictEqual(storedRedshank.tags, ['type:feedback']);
			ok(storedRedshank.content.includes('**Why:** Left tibia bands interfere'));
			ok(storedRedshank.content.includes('**How to apply:** Check sensor placement'));
			deepStrictEqual(storedRedshank.evidenceMemoryIds, [greenshankRec.id]);

			await settleIndex('bob', 'redshank');

			const datasetFile = join(tmpDir, 'eval.jsonl');
			writeFileSync(
				datasetFile,
				[
					JSON.stringify({ prompt: 'redshank banding right tibia sensor', expectedIds: [redshankRec.id] }),
					JSON.stringify({ prompt: 'greenshank estuary roost sector 7G', expectedIds: [greenshankRec.id] }),
				].join('\n'),
			);
			const evalRes = await execNodeScript(evalScript, ['--dataset', datasetFile, '--k', '5', '--json'], '', bobEnv);
			strictEqual(evalRes.code, 0, evalRes.stderr);
			const evalSummary = JSON.parse(evalRes.stdout);
			strictEqual(evalSummary.count, 2);
			strictEqual(evalSummary.recallAtK, 1);
			strictEqual(evalSummary.timeouts, 0);
			ok(typeof evalSummary.latencyMs.p50 === 'number');
		} finally {
			await execNodeScript(
				hookScript,
				[],
				JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId }),
				bobEnv,
			).catch(() => {});
			await new Promise((r) => setTimeout(r, 150));
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
