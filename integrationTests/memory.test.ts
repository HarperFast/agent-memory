// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
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
});
