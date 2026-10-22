import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { __test, databases, logger } from 'harper';
import {
	MemoryActionResource,
	MemoryBootstrapResource,
	MemoryEventsResource,
	MemoryImportResource,
	MemoryItemResource,
	MemoryMcpResource,
	MemoryResource,
	MemoryWatchResource,
} from '../dist/resource.js';
import { setPrincipalResolver } from '../dist/principal.js';
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
		done,
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
	it('delivers created, revised, superseded, withdrawn, restored, and flagged events without content', async () => {
		const stream = await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: aliceUser });
		const collector = collectEvents(stream);

		const id1 = 'mem-sub-level1-01';
		const id2 = 'mem-sub-level1-02';
		const citerId = 'mem-sub-citer-001';

		await MemoryItemResource.put(
			queryTarget('', { id: id1 }),
			{ title: 'first', content: 'first body', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: id1 }),
			{ content: 'first body revised' },
			{ user: aliceUser, headers: { 'if-match': '"1"' } },
		);
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

		// Create another global memory and withdraw it -> label readers (bob, dave) as well as owner (alice) receive withdrawn.
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
		await bobSub.waitForCount(4);
		await daveSub.waitForCount(3);

		// Redacted review flag and private withdrawal: alice creates a global citer that cites her private memory sharedId,
		// then withdraws sharedId. dave and bob can read the global citer, but cannot read the private source sharedId,
		// so they must receive neither 'withdrawn' for sharedId nor 'flagged' for publicCiterId.
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
		await bobSub.waitForCount(5);
		await daveSub.waitForCount(4);

		await MemoryItemResource.delete(queryTarget('', { id: sharedId }), {
			user: aliceUser,
			headers: { 'if-match': '"2"' },
		});
		await aliceSub.waitForCount(9);

		// Emit a final shared marker so bob and dave have processed the preceding private withdrawal and redacted flag.
		const markerId = 'mem-sub-marker-01';
		await MemoryItemResource.put(
			queryTarget('', { id: markerId }),
			{ title: 'marker', content: 'end marker', visibility: 'shared' },
			{ user: aliceUser },
		);
		await bobSub.waitForCount(6);
		await daveSub.waitForCount(5);

		await aliceSub.close();
		await bobSub.close();
		await daveSub.close();

		assert.deepEqual(
			bobSub.received.map((e) => [e.id, e.kind, e.revision]),
			[
				[teamId, 'created', 1],
				[sharedId, 'created', 1],
				[withdrawId, 'created', 1],
				[withdrawId, 'withdrawn', 2],
				[publicCiterId, 'created', 1],
				[markerId, 'created', 1],
			],
		);
		assert.deepEqual(
			daveSub.received.map((e) => [e.id, e.kind, e.revision]),
			[
				[sharedId, 'created', 1],
				[withdrawId, 'created', 1],
				[withdrawId, 'withdrawn', 2],
				[publicCiterId, 'created', 1],
				[markerId, 'created', 1],
			],
		);
		assert.ok(aliceSub.received.some((e) => e.id === publicCiterId && e.kind === 'flagged'));
	});

	it('preserves restored event kind when a restored memory also cited the withdrawn superseder, and preserves created kind on import batch citers', async () => {
		const oldId = 'mem-rest-cite-old';
		const supId = 'mem-rest-cite-sup';
		await MemoryItemResource.put(
			queryTarget('', { id: oldId }),
			{ title: 'old', content: 'old content', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: supId }),
			{ title: 'sup', content: 'supersedes old', visibility: 'shared', supersedes: [oldId] },
			{ user: aliceUser },
		);
		// Seed oldId with a citation to supId while superseded so withdrawing supId both restores and flags oldId in one transaction.
		const oldRow = await databases.memory.Memory.get(oldId);
		await databases.memory.Memory.put({
			...oldRow,
			evidence: [{ kind: 'memory', ref: supId }],
			evidenceMemoryIds: [supId],
		});

		const sub = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: aliceUser }));
		await MemoryItemResource.delete(queryTarget('reason=undo', { id: supId }), {
			user: aliceUser,
			headers: { 'if-match': '"1"' },
		});
		await sub.waitForCount(2);

		const restoredEvent = sub.received.find((e) => e.id === oldId);
		assert.deepEqual(restoredEvent, { id: oldId, kind: 'restored', revision: 3 });
		const restoredRow = await databases.memory.Memory.get(oldId);
		assert.equal(restoredRow.status, 'active');
		assert.equal(restoredRow.lastEventKind, 'restored');
		assert.equal(restoredRow.needsReview?.sourceId, supId);
		assert.equal(restoredRow.needsReview?.cause, 'withdrawn');

		// Import batch where row B supersedes stored oldId and row C cites oldId: C must emit 'created' at revision 1 with needsReview set.
		const impSupId = 'mem-imp-sup-00001';
		const impCitId = 'mem-imp-cit-00001';
		const impRes = await parse(
			await MemoryImportResource.post(
				queryTarget(''),
				{
					rows: [
						{
							id: impSupId,
							ownerId: 'alice',
							title: 'import sup',
							content: 'supersedes oldId',
							scopes: ['global'],
							status: 'active',
							supersedes: [oldId],
						},
						{
							id: impCitId,
							ownerId: 'alice',
							title: 'import citer',
							content: 'cites oldId in same batch',
							scopes: ['global'],
							status: 'active',
							evidence: [{ kind: 'memory', ref: oldId }],
						},
					],
				},
				{ user: superUser },
			),
		);
		assert.equal(impRes.status, 200);
		await sub.waitForCount(5);
		await sub.close();

		const citCreated = sub.received.filter((e) => e.id === impCitId);
		assert.deepEqual(citCreated, [{ id: impCitId, kind: 'created', revision: 1 }]);
		const citRow = await databases.memory.Memory.get(impCitId);
		assert.equal(citRow.revision, 1);
		assert.equal(citRow.lastEventKind, 'created');
		assert.equal(citRow.needsReview?.sourceId, oldId);
		assert.equal(citRow.needsReview?.replacementId, impSupId);
	});

	it('isolates transient per-event read errors with log throttling, deduplicates identical revisions, closes streams when upstream ends, and cleans up on client disconnect', async () => {
		const sub = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: bobUser }));
		const ScopeGrant = databases.memory.ScopeGrant;
		const origGet = ScopeGrant.get;
		const errors = [];
		const origError = logger.error;
		logger.error = (...args) => errors.push(args);

		// Evict bob's cached grant so delivery-time filtering hits ScopeGrant.get.
		await grant('user:bob', ['global'], ['global']);

		let failRemaining = 2;
		ScopeGrant.get = async (id, ctx) => {
			if (failRemaining > 0 && id === 'user:bob') {
				failRemaining -= 1;
				throw new Error('transient storage read error');
			}
			return origGet.call(ScopeGrant, id, ctx);
		};

		try {
			await MemoryItemResource.put(
				queryTarget('', { id: 'mem-err-skip-0001' }),
				{ title: 'first', content: 'skipped due to transient grant error', visibility: 'shared' },
				{ user: aliceUser },
			);
			await MemoryItemResource.put(
				queryTarget('', { id: 'mem-err-skip-0002' }),
				{ title: 'second', content: 'also skipped; error log throttled within window', visibility: 'shared' },
				{ user: aliceUser },
			);
			await MemoryItemResource.put(
				queryTarget('', { id: 'mem-err-keep-0003' }),
				{ title: 'third', content: 'delivered after recovery', visibility: 'shared' },
				{ user: aliceUser },
			);
			await sub.waitForCount(1);
			assert.deepEqual(sub.received, [{ id: 'mem-err-keep-0003', kind: 'created', revision: 1 }]);
			assert.equal(errors.length, 1);
		} finally {
			ScopeGrant.get = origGet;
			logger.error = origError;
			await sub.close();
		}

		// Deduplication of repeated (id, revision) and upstream iterator completion closing client streams.
		const Memory = databases.memory.Memory;
		const origSubscribe = Memory.subscribe;
		let pushUpstream;
		let finishUpstream;
		let upstreamEndCalls = 0;
		Memory.subscribe = async () => {
			const items = [];
			let resolveNext;
			let ended = false;
			pushUpstream = (ev) => {
				if (resolveNext) {
					const r = resolveNext;
					resolveNext = null;
					r({ value: ev, done: false });
				} else {
					items.push(ev);
				}
			};
			finishUpstream = () => {
				ended = true;
				if (resolveNext) {
					const r = resolveNext;
					resolveNext = null;
					r({ value: undefined, done: true });
				}
			};
			return {
				end() {
					upstreamEndCalls += 1;
					finishUpstream();
				},
				[Symbol.asyncIterator]() {
					return {
						next() {
							if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
							if (ended) return Promise.resolve({ value: undefined, done: true });
							return new Promise((resolve) => {
								resolveNext = resolve;
							});
						},
						return() {
							upstreamEndCalls += 1;
							return Promise.resolve({ value: undefined, done: true });
						},
					};
				},
			};
		};

		try {
			const nodeRes = new EventEmitter();
			const sseStream = await MemoryResource.connect(queryTarget('', { rest: '' }), null, {
				user: bobUser,
				_nodeResponse: nodeRes,
			});
			const collected = collectEvents(sseStream);
			const dupEvent = {
				id: 'mem-dup-event-001',
				type: 'put',
				value: {
					id: 'mem-dup-event-001',
					ownerId: 'alice',
					scopes: ['global'],
					status: 'active',
					revision: 1,
					lastEventKind: 'created',
				},
			};
			pushUpstream(dupEvent);
			pushUpstream(dupEvent);
			await collected.waitForCount(1);
			finishUpstream();
			await collected.done;
			assert.deepEqual(collected.received, [{ id: 'mem-dup-event-001', kind: 'created', revision: 1 }]);

			// Disconnect via _nodeResponse 'close' event releases the hub subscription.
			const nodeRes2 = new EventEmitter();
			const sseStream2 = await MemoryResource.connect(queryTarget('', { rest: '' }), null, {
				user: bobUser,
				_nodeResponse: nodeRes2,
			});
			const collected2 = collectEvents(sseStream2);
			nodeRes2.emit('close');
			await collected2.done;
			assert.ok(upstreamEndCalls >= 1);
		} finally {
			Memory.subscribe = origSubscribe;
		}
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
			MemoryMcpResource,
		]) {
			const res = await parse(
				await ResourceClass.connect(queryTarget('', { id: 'mem-sub-publ-0001', action: 'pin' }), null, {
					user: aliceUser,
				}),
			);
			assert.equal(res.status, 405);
		}
		assert.equal((await parse(await MemoryMcpResource.get(queryTarget(''), { user: aliceUser }))).status, 405);
	});
});

describe('Level 2: MemoryWatch, watch=true on search/bootstrap, and /MemoryEvents', () => {
	it('POST /Memory/watch validates payload, rejects missing or unreadable ids with identical 404, records watches, and never shortens an existing watch TTL', async () => {
		const pubId = 'mem-watch-pub-001';
		const pubId2 = 'mem-watch-pub-002';
		const privId = 'mem-watch-prv-001';
		await MemoryItemResource.put(
			queryTarget('', { id: pubId }),
			{ title: 'pub', content: 'pub content', visibility: 'shared' },
			{ user: aliceUser },
		);
		await MemoryItemResource.put(
			queryTarget('', { id: pubId2 }),
			{ title: 'pub2', content: 'pub2 content', visibility: 'shared' },
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

		__test.lockLog.length = 0;
		const longWatch = await parse(
			await MemoryWatchResource.post(queryTarget(''), { ids: [pubId, pubId], ttlSeconds: 7200 }, { user: bobUser }),
		);
		assert.equal(longWatch.status, 200);
		assert.deepEqual(longWatch.body.watched, [pubId]);
		assert.ok(
			__test.lockLog.some(
				(entry) => entry.table === 'MemoryWatch' && entry.id === `bob:${pubId}` && entry.inTransaction,
			),
		);
		const longExpiry = Date.parse(longWatch.body.expiresAt);
		assert.ok(Number.isFinite(longExpiry));
		const storedLong = await databases.memory.MemoryWatch.get(`bob:${pubId}`);
		assert.equal(storedLong.principalId, 'bob');
		assert.equal(storedLong.memoryId, pubId);
		assert.equal(storedLong.expiresAt.getTime(), longExpiry);

		// Locks are acquired in deterministic sorted id order even when caller passes [pubId2, pubId],
		// while `watched` preserves caller input order; a shorter explicit watch or watch=true search
		// (default 3600s) keeps the longer 7200s expiry and reports the earliest effective expiresAt.
		__test.lockLog.length = 0;
		const shortWatch = await parse(
			await MemoryWatchResource.post(queryTarget(''), { ids: [pubId2, pubId], ttlSeconds: 60 }, { user: bobUser }),
		);
		assert.equal(shortWatch.status, 200);
		assert.deepEqual(shortWatch.body.watched, [pubId2, pubId]);
		const watchLocks = __test.lockLog.filter((entry) => entry.table === 'MemoryWatch').map((entry) => entry.id);
		assert.deepEqual(watchLocks, [`bob:${pubId}`, `bob:${pubId2}`]);
		const storedShort2 = await databases.memory.MemoryWatch.get(`bob:${pubId2}`);
		assert.equal(Date.parse(shortWatch.body.expiresAt), storedShort2.expiresAt.getTime());
		assert.ok(Date.parse(shortWatch.body.expiresAt) < longExpiry);
		await MemoryResource.get(queryTarget('q=pub&watch=true', { rest: '' }), { user: bobUser });
		const afterShort = await databases.memory.MemoryWatch.get(`bob:${pubId}`);
		assert.equal(afterShort.expiresAt.getTime(), longExpiry);
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

	it('/MemoryEvents delivers events for watched memories and own flagged memories (including folded needsReview), honours expiry, and forbids principal in path', async () => {
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

		// Import batch where row A supersedes unwatchedId and row B (owned by Bob, unwatched) cites unwatchedId ->
		// B has needsReview folded into its 'created' transition, so Bob receives B's 'created' event on /MemoryEvents.
		const bobFoldedCiterId = 'mem-events-bobfld';
		await MemoryImportResource.post(
			queryTarget(''),
			{
				rows: [
					{
						id: 'mem-events-impsup',
						ownerId: 'alice',
						title: 'sup',
						content: 'supersedes unwatchedId',
						scopes: ['global'],
						status: 'active',
						supersedes: [unwatchedId],
					},
					{
						id: bobFoldedCiterId,
						ownerId: 'bob',
						title: 'bob folded citer',
						content: 'cites unwatchedId in import batch',
						scopes: ['global'],
						status: 'active',
						evidence: [{ kind: 'memory', ref: unwatchedId }],
					},
				],
			},
			{ user: superUser },
		);

		await bobEvents.waitForCount(3);

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
			{ id: bobFoldedCiterId, kind: 'created', revision: 1 },
		]);
	});

	it('bounds database reads during flagged fan-out across multiple subscribers and closes a stalled subscriber whose pending queue exceeds 256 events', async () => {
		const sourceId = 'mem-fanout-src-01';
		await MemoryItemResource.put(
			queryTarget('', { id: sourceId }),
			{ title: 'shared source', content: 'source body', visibility: 'shared' },
			{ user: aliceUser },
		);
		const citerIds = [];
		for (let i = 0; i < 6; i += 1) {
			const citerId = `mem-fanout-cit-0${i}`;
			citerIds.push(citerId);
			await MemoryItemResource.put(
				queryTarget('', { id: citerId }),
				{
					title: `citer ${i}`,
					content: `cites ${sourceId}`,
					visibility: 'shared',
					evidence: [{ kind: 'memory', ref: sourceId }],
				},
				{ user: i % 2 === 0 ? bobUser : aliceUser },
			);
		}
		await MemoryWatchResource.post(queryTarget(''), { ids: citerIds, ttlSeconds: 300 }, { user: bobUser });
		await MemoryWatchResource.post(queryTarget(''), { ids: citerIds, ttlSeconds: 300 }, { user: daveUser });

		let customResolverCalls = 0;
		setPrincipalResolver(async (ctx, next) => {
			customResolverCalls += 1;
			return next(ctx);
		});

		const subAlice = collectEvents(await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: aliceUser }));
		const subBob = collectEvents(await MemoryEventsResource.connect(queryTarget(''), null, { user: bobUser }));
		const subDave = collectEvents(await MemoryEventsResource.connect(queryTarget(''), null, { user: daveUser }));

		// Warm each subscriber once so initial watch seeding and per-listener principal cache fill are complete before measuring the burst.
		await MemoryItemResource.put(
			queryTarget('', { id: citerIds[0] }),
			{ content: 'warm burst check' },
			{ user: bobUser, headers: { 'if-match': '"1"' } },
		);
		await subAlice.waitForCount(1);
		await subBob.waitForCount(1);
		await subDave.waitForCount(1);

		const Memory = databases.memory.Memory;
		const MemoryWatch = databases.memory.MemoryWatch;
		const ScopeGrant = databases.memory.ScopeGrant;
		const origMemorySearch = Memory.search;
		const origWatchGet = MemoryWatch.get;
		const origGrantGet = ScopeGrant.get;
		let memorySearchCalls = 0;
		let watchGetCalls = 0;
		let grantGetCalls = 0;
		let failFirstSourceLookup = true;
		Memory.search = function (query, ...rest) {
			memorySearchCalls += 1;
			// Simulate one transient search error on the first flagAccessCache lookup to verify failed promises are evicted and retried.
			if (failFirstSourceLookup && query?.conditions?.[0]?.attribute === 'id') {
				failFirstSourceLookup = false;
				return {
					async *[Symbol.asyncIterator]() {
						throw new Error('transient search failure');
					},
				};
			}
			return origMemorySearch.call(this, query, ...rest);
		};
		MemoryWatch.get = function (...args) {
			watchGetCalls += 1;
			return origWatchGet.apply(this, args);
		};
		ScopeGrant.get = function (...args) {
			grantGetCalls += 1;
			return origGrantGet.apply(this, args);
		};

		try {
			customResolverCalls = 0;
			// Withdrawing sourceId writes 1 withdrawn event + 6 flagged citer events across 3 open subscribers (21 listener checks).
			// The first flagged event hits the simulated transient search failure (which clears flagAccessCache), and the remaining
			// 5 flagged events retry and share a single successful Memory.search([sourceId]).
			await MemoryItemResource.delete(queryTarget('', { id: sourceId }), {
				user: aliceUser,
				headers: { 'if-match': '"1"' },
			});
			await subAlice.waitForCount(7);
			await subBob.waitForCount(6);
			await subDave.waitForCount(6);

			assert.ok(memorySearchCalls <= 4, `expected <= 4 Memory.search calls, got ${memorySearchCalls}`);
			assert.equal(watchGetCalls, 0);
			// Only the DELETE request's own prepareContext resolves user:alice once; all 21 subscriber checks hit principalCache.
			assert.equal(grantGetCalls, 1);
			assert.equal(customResolverCalls, 1);
		} finally {
			setPrincipalResolver(null);
			Memory.search = origMemorySearch;
			MemoryWatch.get = origWatchGet;
			ScopeGrant.get = origGrantGet;
			await subAlice.close();
			await subBob.close();
			await subDave.close();
		}

		// 1) A draining subscriber survives a synchronous burst of 300 events even when the first filter step awaits I/O.
		// 2) A stalled subscriber that does not drain its iterator is closed once > 256 events accumulate in its client buffer.
		const origSubscribe = Memory.subscribe;
		let upstreamQueue = [];
		let upstreamWaiter;
		const emitUpstream = (ev) => {
			if (upstreamWaiter) {
				const resolve = upstreamWaiter;
				upstreamWaiter = undefined;
				resolve({ value: ev, done: false });
			} else {
				upstreamQueue.push(ev);
			}
		};
		Memory.subscribe = async () => ({
			end() {},
			[Symbol.asyncIterator]() {
				return {
					next() {
						if (upstreamQueue.length > 0) {
							return Promise.resolve({ value: upstreamQueue.shift(), done: false });
						}
						return new Promise((resolve) => {
							upstreamWaiter = resolve;
						});
					},
					return() {
						return Promise.resolve({ value: undefined, done: true });
					},
				};
			},
		});

		try {
			let firstLookup = true;
			setPrincipalResolver(async (ctx, next) => {
				if (firstLookup) {
					firstLookup = false;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				return next(ctx);
			});
			const drainingSub = collectEvents(
				await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: bobUser }),
			);
			const stalledStream = await MemoryResource.subscribe(queryTarget('', { rest: '' }), { user: daveUser });
			for (let rev = 1; rev <= 300; rev += 1) {
				emitUpstream({
					id: 'mem-overflow-0001',
					type: 'put',
					value: {
						id: 'mem-overflow-0001',
						ownerId: 'alice',
						scopes: ['global'],
						status: 'active',
						revision: rev,
						lastEventKind: 'revised',
					},
				});
			}
			await drainingSub.waitForCount(300);
			assert.equal(drainingSub.received.length, 300);
			await drainingSub.close();

			const drainedStalled = [];
			for await (const ev of stalledStream) {
				drainedStalled.push(ev);
			}
			assert.equal(drainedStalled.length, 256);
		} finally {
			setPrincipalResolver(null);
			Memory.subscribe = origSubscribe;
		}
	});
});

describe('MCP tools and custom resource on MemoryMcpResource', () => {
	beforeEach(() => {
		applySettings(parseSettings({ mcp: true }));
	});

	it('executes remember, revise, recall (with watch), get, pin, unpin, confirm, watch, withdraw, and memory:///{id} with the same rules as REST', async () => {
		const watchTool = MemoryMcpResource.mcpTools.find((t) => t.name === 'watch');
		assert.equal(watchTool.inputSchema.properties.ids.maxItems, 100);
		assert.equal(watchTool.inputSchema.properties.ttlSeconds.maximum, 86400);

		const resource = new MemoryMcpResource();
		const aliceCtx = { user: aliceUser };
		const bobCtx = { user: bobUser };

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
		assert.deepEqual(created, {
			id: explicitId,
			revision: 1,
			created: true,
			candidates: [],
			scopes: ['global'],
			status: 'active',
			contentFlag: null,
			needsReview: null,
		});

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

		const revised = await resource.mcpRevise({ id: explicitId, revision: 1, content: 'revised via mcp' }, aliceCtx);
		assert.deepEqual(revised, {
			id: explicitId,
			revision: 2,
			created: false,
			candidates: [],
			scopes: ['global'],
			status: 'active',
			contentFlag: null,
			needsReview: null,
		});

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

		const recalled = await resource.mcpRecall({ q: 'revised', tags: [], watch: true }, bobCtx);
		assert.ok(recalled.memories.some((m) => m.id === explicitId));
		assert.ok(await databases.memory.MemoryWatch.get(`bob:${explicitId}`));

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
