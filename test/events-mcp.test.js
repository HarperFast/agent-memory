import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import {
	MemoryActionResource,
	MemoryBootstrapResource,
	MemoryEventsResource,
	MemoryImportResource,
	MemoryItemResource,
	MemoryResource,
	MemoryWatchResource,
} from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const aliceUser = { username: 'alice' };
const bobUser = { username: 'bob' };
const daveUser = { username: 'dave' };
const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };

const parse = async (response) => ({
	status: response.status,
	headers: response.headers,
	body: await response.json(),
});
const queryTarget = (query = '', params = {}) => Object.assign(new URLSearchParams(query), params);

async function grant(principalKey, read = [], write = []) {
	await databases.memory.ScopeGrant.put({ id: principalKey, read, write });
}

function collectEvents(stream) {
	const received = [];
	const done = (async () => {
		for await (const event of stream) {
			received.push(event);
		}
	})();
	return {
		received,
		async waitForCount(count, timeoutMs = 1000) {
			const deadline = Date.now() + timeoutMs;
			while (received.length < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		},
		async close() {
			stream.end();
			await done;
		},
	};
}

beforeEach(async () => {
	__test.reset();
	applySettings(parseSettings({}));
	await grant('user:alice', ['global', 'team:eng'], ['global', 'team:eng']);
	await grant('user:bob', ['global'], ['global']);
	await grant('user:dave', ['global'], []);
});

describe('Level 1: record-change subscriptions on Memory', () => {
	it('delivers created, revised, superseded, withdrawn, restored, and flagged events without content, and sets non-enumerable value for MQTT', async () => {
		const stream = await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: aliceUser });
		const collector = collectEvents(stream);

		const id1 = 'mem-sub-level1-01';
		const id2 = 'mem-sub-level1-02';
		const citerId = 'mem-sub-citer-001';

		// 1. created (id1)
		await MemoryItemResource.put(
			queryTarget('', { id: id1 }),
			{ title: 'first', content: 'first body', visibility: 'shared' },
			{ user: aliceUser },
		);
		// 2. revised (id1 -> rev 2)
		await MemoryItemResource.put(
			queryTarget('', { id: id1 }),
			{ content: 'first body revised' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		// 3. created (citer citing id1)
		await MemoryItemResource.put(
			queryTarget('', { id: citerId }),
			{
				title: 'citer',
				content: 'cites id1',
				visibility: 'shared',
				evidence: [{ kind: 'memory', ref: id1 }],
			},
			{ user: aliceUser },
		);
		// 4. supersede id1 with id2 -> emits created(id2), superseded(id1 rev 3), flagged(citerId rev 2)
		await MemoryItemResource.put(
			queryTarget('', { id: id2 }),
			{
				title: 'second',
				content: 'replaces first',
				visibility: 'shared',
				supersedes: [id1],
			},
			{ user: aliceUser },
		);
		// 5. withdraw id2 -> emits restored(id1 rev 4) and withdrawn(id2 rev 2)
		await MemoryItemResource.delete(queryTarget('reason=retract', { id: id2 }), {
			user: aliceUser,
			headers: { 'if-match': '"1"' },
		});

		await collector.waitForCount(8);
		await collector.close();

		assert.deepEqual(collector.received, [
			{ id: id1, kind: 'created', revision: 1 },
			{ id: id1, kind: 'revised', revision: 2 },
			{ id: citerId, kind: 'created', revision: 1 },
			{ id: id2, kind: 'created', revision: 1 },
			{ id: id1, kind: 'superseded', revision: 3 },
			{ id: citerId, kind: 'flagged', revision: 2 },
			{ id: id1, kind: 'restored', revision: 4 },
			{ id: id2, kind: 'withdrawn', revision: 2 },
		]);
		for (const event of collector.received) {
			assert.deepEqual(Object.keys(event), ['id', 'kind', 'revision']);
			assert.equal(event.value, event);
			assert.equal('content' in event, false);
			assert.equal('title' in event, false);
		}
	});

	it('re-evaluates the subscriber read rule at delivery time across scope narrowing, grant revocation, withdrawal, and redacted flags', async () => {
		await grant('user:bob', ['global', 'team:eng'], ['global']);
		const aliceSub = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: aliceUser }));
		const bobSub = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: bobUser }));
		const daveSub = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: daveUser }));

		const teamId = 'mem-sub-team-0001';
		// Created in team:eng -> alice and bob see it; dave does not.
		await MemoryItemResource.put(
			queryTarget('', { id: teamId }),
			{ title: 'team note', content: 'eng only', scopes: ['team:eng'] },
			{ user: aliceUser },
		);
		await aliceSub.waitForCount(1);
		await bobSub.waitForCount(1);

		// Revoke bob's team:eng grant mid-subscription -> bob must not receive subsequent revisions of teamId.
		await grant('user:bob', ['global'], ['global']);
		await MemoryItemResource.put(
			queryTarget('', { id: teamId }),
			{ content: 'eng only v2' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		await aliceSub.waitForCount(2);

		// Create a global memory, then narrow its scope to user:alice -> bob and dave must not receive the narrowing revision.
		const sharedId = 'mem-sub-shared-01';
		await MemoryItemResource.put(
			queryTarget('', { id: sharedId }),
			{ title: 'shared note', content: 'public first', visibility: 'shared' },
			{ user: aliceUser },
		);
		await bobSub.waitForCount(2);
		await daveSub.waitForCount(1);

		await MemoryItemResource.put(
			queryTarget('', { id: sharedId }),
			{ visibility: 'private' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		await aliceSub.waitForCount(4);

		// Create another global memory and withdraw it -> owner (alice) receives withdrawn; non-owners (bob, dave) do not.
		const withdrawId = 'mem-sub-withdr-01';
		await MemoryItemResource.put(
			queryTarget('', { id: withdrawId }),
			{ title: 'to withdraw', content: 'temp shared', visibility: 'shared' },
			{ user: aliceUser },
		);
		await bobSub.waitForCount(3);
		await daveSub.waitForCount(2);

		await MemoryItemResource.delete(queryTarget('', { id: withdrawId }), {
			user: aliceUser,
			headers: { 'if-match': '"1"' },
		});
		await aliceSub.waitForCount(6);

		// Redacted review flag: alice creates a global citer that cites her private memory sharedId, then withdraws sharedId.
		// dave can read the global citer, but cannot read the private source sharedId, so dave must NOT receive 'flagged'.
		const publicCiterId = 'mem-sub-pubcite-1';
		await MemoryItemResource.put(
			queryTarget('', { id: publicCiterId }),
			{
				title: 'public conclusion',
				content: 'cites private source',
				visibility: 'shared',
				evidence: [{ kind: 'memory', ref: sharedId }],
			},
			{ user: aliceUser },
		);
		await daveSub.waitForCount(3);

		await MemoryItemResource.delete(queryTarget('', { id: sharedId }), {
			user: aliceUser,
			headers: { 'if-match': '"2"' },
		});
		await aliceSub.waitForCount(9);

		await aliceSub.close();
		await bobSub.close();
		await daveSub.close();

		assert.deepEqual(
			bobSub.received.map((e) => [e.id, e.kind, e.revision]),
			[
				[teamId, 'created', 1],
				[sharedId, 'created', 1],
				[withdrawId, 'created', 1],
				[publicCiterId, 'created', 1],
			],
		);
		assert.deepEqual(
			daveSub.received.map((e) => [e.id, e.kind, e.revision]),
			[
				[sharedId, 'created', 1],
				[withdrawId, 'created', 1],
				[publicCiterId, 'created', 1],
			],
		);
		assert.ok(aliceSub.received.some((e) => e.id === publicCiterId && e.kind === 'flagged'));
	});

	it('supports single-item subscriptions on /Memory/:id and rejects missing or unreadable ids with identical 404', async () => {
		const privId = 'mem-sub-priv-0001';
		const pubId = 'mem-sub-publ-0001';
		await MemoryItemResource.put(
			queryTarget('', { id: privId }),
			{ title: 'alice private', content: 'secret', visibility: 'private' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: pubId }),
			{ title: 'public', content: 'open', visibility: 'shared' },
			{ user: aliceUser },
		);

		const missingRes = await parse(
			await MemoryItemResource.connect(queryTarget('', { id: 'mem-does-not-exist' }), null, { user: bobUser }),
		);
		const unreadableRes = await parse(
			await MemoryItemResource.connect(queryTarget('', { id: privId }), null, { user: bobUser }),
		);
		assert.equal(missingRes.status, 404);
		assert.equal(unreadableRes.status, 404);
		assert.deepEqual(unreadableRes.body, missingRes.body);

		const itemSub = collectEvents(
			await MemoryItemResource.connect(queryTarget('', { id: pubId }), null, { user: bobUser }),
		);
		await MemoryItemResource.put(
			queryTarget('', { id: privId }),
			{ content: 'secret v2' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: pubId }),
			{ content: 'open v2' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		await itemSub.waitForCount(1);
		await itemSub.close();

		assert.deepEqual(itemSub.received, [{ id: pubId, kind: 'revised', revision: 2 }]);
	});

	it('rejects unauthenticated and unsupported subscription endpoints across SSE and WebSocket connect()', async () => {
		const unauthSse = await parse(await MemoryResource.connect(queryTarget('', { rest: '' }), null, {}));
		assert.equal(unauthSse.status, 401);

		await assert.rejects(
			() => MemoryResource.connect(queryTarget('', { rest: '' }), (async function* () {})(), {}),
			(err) => err.statusCode === 401 && err.code === 'principal_required',
		);

		for (const ResourceClass of [
			MemoryBootstrapResource,
			MemoryImportResource,
			MemoryWatchResource,
			MemoryActionResource,
		]) {
			const res = await parse(
				await ResourceClass.connect(queryTarget('', { id: 'mem-sub-publ-0001', action: 'pin' }), null, {
					user: aliceUser,
				}),
			);
			assert.equal(res.status, 405);
		}
	});
});

describe('Level 2: MemoryWatch, watch=true on search/bootstrap, and /MemoryEvents', () => {
	it('POST /Memory/watch validates payload, rejects missing or unreadable ids with identical 404, and records watches', async () => {
		const pubId = 'mem-watch-pub-001';
		const privId = 'mem-watch-prv-001';
		await MemoryItemResource.put(
			queryTarget('', { id: pubId }),
			{ title: 'pub', content: 'pub content', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: privId }),
			{ title: 'priv', content: 'priv content', visibility: 'private' },
			{ user: aliceUser },
		);

		// Missing and unreadable return identical 404 and write no partial watch rows.
		const missing = await parse(
			await MemoryWatchResource.post(
				queryTarget(''),
				{ ids: [pubId, 'mem-watch-missing1'], ttlSeconds: 120 },
				{ user: bobUser },
			),
		);
		const unreadable = await parse(
			await MemoryWatchResource.post(queryTarget(''), { ids: [pubId, privId], ttlSeconds: 120 }, { user: bobUser }),
		);
		assert.equal(missing.status, 404);
		assert.equal(unreadable.status, 404);
		assert.deepEqual(unreadable.body, missing.body);
		assert.equal(await databases.memory.MemoryWatch.get(`bob:${pubId}`), null);

		// Invalid inputs return 400.
		for (const badBody of [
			{},
			{ ids: [] },
			{ ids: ['short'] },
			{ ids: [pubId], ttlSeconds: 0 },
			{ ids: [pubId], ttlSeconds: 86401 },
			{ ids: [pubId], extra: true },
		]) {
			const res = await parse(await MemoryWatchResource.post(queryTarget(''), badBody, { user: bobUser }));
			assert.equal(res.status, 400, JSON.stringify(badBody));
		}

		const ok = await parse(
			await MemoryWatchResource.post(queryTarget(''), { ids: [pubId, pubId], ttlSeconds: 120 }, { user: bobUser }),
		);
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.body.watched, [pubId]);
		assert.ok(typeof ok.body.expiresAt === 'string');
		const stored = await databases.memory.MemoryWatch.get(`bob:${pubId}`);
		assert.equal(stored.principalId, 'bob');
		assert.equal(stored.memoryId, pubId);
	});

	it('watch=true on search and bootstrap watches every returned memory id', async () => {
		const m1 = 'mem-watch-srch-01';
		const m2 = 'mem-watch-srch-02';
		await MemoryItemResource.put(
			queryTarget('', { id: m1 }),
			{ title: 'searchable one', content: 'zephyr topic', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: m2 }),
			{ title: 'big skipped', content: `zephyr ${'x'.repeat(500)}`, visibility: 'shared' },
			{ user: aliceUser },
		);

		const searched = await parse(
			await MemoryResource.get(queryTarget('q=zephyr&limit=1&watch=true', { rest: '' }), { user: bobUser }),
		);
		assert.equal(searched.status, 200);
		assert.equal(searched.body.memories.length, 1);
		const watchedBySearch = searched.body.memories[0].id;
		assert.ok(await databases.memory.MemoryWatch.get(`bob:${watchedBySearch}`));

		// Bootstrap with tight budget watches only the returned memories, not candidates skipped by the budget.
		const boot = await parse(
			await MemoryBootstrapResource.get(queryTarget('q=zephyr&budget=100&watch=true'), { user: daveUser }),
		);
		assert.equal(boot.status, 200);
		assert.deepEqual(
			boot.body.memories.map((m) => m.id),
			[m1],
		);
		assert.ok(await databases.memory.MemoryWatch.get(`dave:${m1}`));
		assert.equal(await databases.memory.MemoryWatch.get(`dave:${m2}`), null);
	});

	it('/MemoryEvents delivers events for watched memories and own flagged memories, honours expiry, and forbids principal in path', async () => {
		// Any principal or subpath on /MemoryEvents is 404.
		const pathWithPrincipal = await parse(
			await MemoryEventsResource.connect(queryTarget('', { pathname: 'bob' }), null, { user: bobUser }),
		);
		assert.equal(pathWithPrincipal.status, 404);
		assert.equal(
			(await parse(await MemoryEventsResource.get(queryTarget('', { pathname: 'bob' }), { user: bobUser }))).status,
			404,
		);
		assert.equal((await parse(await MemoryEventsResource.get(queryTarget(''), { user: bobUser }))).status, 405);

		const watchedId = 'mem-events-watch1';
		const unwatchedId = 'mem-events-unwtc1';
		const sourceId = 'mem-events-src001';
		const bobOwnCiterId = 'mem-events-bobct1';

		await MemoryItemResource.put(
			queryTarget('', { id: watchedId }),
			{ title: 'watched', content: 'watched content', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: unwatchedId }),
			{ title: 'unwatched', content: 'unwatched content', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: sourceId }),
			{ title: 'source', content: 'source content', visibility: 'shared' },
			{ user: aliceUser },
		);
		// Bob owns bobOwnCiterId citing sourceId, but Bob does NOT watch bobOwnCiterId or sourceId.
		await MemoryItemResource.put(
			queryTarget('', { id: bobOwnCiterId }),
			{
				title: 'bob citer',
				content: 'cites sourceId',
				visibility: 'shared',
				evidence: [{ kind: 'memory', ref: sourceId }],
			},
			{ user: bobUser },
		);

		await MemoryWatchResource.post(queryTarget(''), { ids: [watchedId], ttlSeconds: 300 }, { user: bobUser });

		const bobEvents = collectEvents(await MemoryEventsResource.connect(queryTarget(''), null, { user: bobUser }));

		// Revise unwatchedId -> Bob does NOT receive it.
		await MemoryItemResource.put(
			queryTarget('', { id: unwatchedId }),
			{ content: 'unwatched v2' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		// Revise watchedId -> Bob DOES receive it.
		await MemoryItemResource.put(
			queryTarget('', { id: watchedId }),
			{ content: 'watched v2' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
		// Withdraw sourceId -> flags bobOwnCiterId (owned by Bob), so Bob receives 'flagged' for bobOwnCiterId!
		await MemoryItemResource.delete(queryTarget('', { id: sourceId }), {
			user: aliceUser,
			headers: { 'if-match': '"1"' },
		});

		await bobEvents.waitForCount(2);

		// Expire Bob's watch on watchedId -> subsequent revision is not delivered.
		await databases.memory.MemoryWatch.put({
			id: `bob:${watchedId}`,
			principalId: 'bob',
			memoryId: watchedId,
			expiresAt: new Date(Date.now() - 1000),
		});
		await MemoryItemResource.put(
			queryTarget('', { id: watchedId }),
			{ content: 'watched v3 after expiry' },
			{ user: aliceUser, headers: { 'if-match': '"2"' } },
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await bobEvents.close();

		assert.deepEqual(bobEvents.received, [
			{ id: watchedId, kind: 'revised', revision: 2 },
			{ id: bobOwnCiterId, kind: 'flagged', revision: 2 },
		]);
	});
});

describe('MCP tools and custom resource on MemoryResource', () => {
	beforeEach(() => {
		applySettings(parseSettings({ mcp: true }));
	});

	it('executes remember, revise, recall (with watch), get, pin, unpin, confirm, watch, withdraw, and memory:///{id} with the same rules as REST', async () => {
		const resource = new MemoryResource();
		const aliceCtx = { user: aliceUser };
		const bobCtx = { user: bobUser };

		// 1. remember (generated UUID and explicit id + idempotent retry)
		const autoCreated = await resource.mcpRemember(
			{ title: 'auto id memory', content: 'remembered via mcp', visibility: 'shared', tags: ['mcp'] },
			aliceCtx,
		);
		assert.equal(autoCreated.created, true);
		assert.equal(autoCreated.revision, 1);
		assert.match(autoCreated.id, /^[0-9a-f-]{36}$/);

		const explicitId = 'mem-mcp-explicit1';
		const created = await resource.mcpRemember(
			{ id: explicitId, title: 'explicit', content: 'initial content', visibility: 'shared' },
			aliceCtx,
		);
		assert.deepEqual(created, { id: explicitId, revision: 1, created: true, candidates: [] });

		const retry = await resource.mcpRemember(
			{ id: explicitId, title: 'explicit', content: 'initial content', visibility: 'shared' },
			aliceCtx,
		);
		assert.equal(retry.created, false);
		assert.equal(retry.revision, 1);

		// Different content on remember for existing id fails with 428 if_match_required.
		await assert.rejects(
			() => resource.mcpRemember({ id: explicitId, title: 'explicit', content: 'changed' }, aliceCtx),
			(err) =>
				err.statusCode === 428 && err.code === 'if_match_required' && err.errors?.[0]?.code === 'if_match_required',
		);

		// 2. revise
		const revised = await resource.mcpRevise({ id: explicitId, revision: 1, content: 'revised via mcp' }, aliceCtx);
		assert.deepEqual(revised, { id: explicitId, revision: 2, created: false, candidates: [] });

		await assert.rejects(
			() => resource.mcpRevise({ id: explicitId, revision: 1, content: 'stale' }, aliceCtx),
			(err) => err.statusCode === 412 && err.code === 'precondition_failed',
		);
		await assert.rejects(
			() => resource.mcpRevise({ id: explicitId, revision: 2, content: 'no', supersedes: [autoCreated.id] }, aliceCtx),
			(err) => err.statusCode === 400 && err.code === 'supersedes_not_allowed',
		);
		await assert.rejects(
			() => resource.mcpRevise({ id: explicitId, revision: 2, content: 'bob edit' }, bobCtx),
			(err) => err.statusCode === 403 && err.code === 'not_memory_owner',
		);

		// 3. get and memory:///{id} custom resource read
		const got = await resource.mcpGet({ id: explicitId }, bobCtx);
		assert.equal(got.memory.id, explicitId);
		assert.equal(got.memory.content, 'revised via mcp');

		const readView = await resource.mcpReadMemory({ id: explicitId }, bobCtx);
		assert.equal(readView.id, explicitId);
		assert.equal(readView.revision, 2);

		// Private memory is indistinguishable from missing on both mcpGet and mcpReadMemory.
		const priv = await resource.mcpRemember(
			{ id: 'mem-mcp-private-1', title: 'secret', content: 'alice only', visibility: 'private' },
			aliceCtx,
		);
		await assert.rejects(
			() => resource.mcpGet({ id: priv.id }, bobCtx),
			(err) => err.statusCode === 404 && err.code === 'memory_not_found',
		);
		assert.equal(await resource.mcpReadMemory({ id: priv.id }, bobCtx), undefined);
		assert.equal(await resource.mcpReadMemory({ id: 'mem-mcp-missing-1' }, bobCtx), undefined);
		assert.equal(await resource.mcpReadMemory({ id: explicitId }, {}), undefined);

		// 4. recall (with watch: true)
		const recalled = await resource.mcpRecall({ q: 'revised', tags: [], watch: true }, bobCtx);
		assert.ok(recalled.memories.some((m) => m.id === explicitId));
		assert.ok(await databases.memory.MemoryWatch.get(`bob:${explicitId}`));

		// 5. pin, unpin, confirm, watch, withdraw
		const pinned = await resource.mcpPin({ id: explicitId }, bobCtx);
		assert.equal(pinned.pinned, true);
		const unpinned = await resource.mcpUnpin({ id: explicitId }, bobCtx);
		assert.equal(unpinned.pinned, false);

		const confirmed = await resource.mcpConfirm({ id: explicitId, revision: 2 }, aliceCtx);
		assert.equal(confirmed.memory.revision, 3);
		assert.equal(confirmed.memory.confirmed.by, 'alice');

		const watched = await resource.mcpWatch({ ids: [explicitId], ttlSeconds: 60 }, bobCtx);
		assert.deepEqual(watched.watched, [explicitId]);

		// Withdraw by non-reader returns 404 even when revision is omitted.
		await assert.rejects(
			() => resource.mcpWithdraw({ id: priv.id }, bobCtx),
			(err) => err.statusCode === 404 && err.code === 'memory_not_found',
		);

		const withdrawn = await resource.mcpWithdraw({ id: explicitId, revision: 3, reason: 'retired' }, aliceCtx);
		assert.equal(withdrawn.memory.status, 'withdrawn');
		assert.equal(withdrawn.memory.withdrawnReason, 'retired');
	});
});
