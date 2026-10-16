import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases, models } from 'harper';
import {
	BOOTSTRAP_PINNED_LIMIT,
	EVIDENCE_MAX_ITEMS,
	EVIDENCE_NOTE_MAX_CHARS,
	EVIDENCE_REF_MAX_CHARS,
	getMemory,
	pinMemory,
	putMemory,
	unpinMemory,
	withdrawMemory,
} from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { registerMemorySink } from '../dist/sinks.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const grant = (id, read, write) => createPrincipal({ id, grants: { read, write } });
const alice = grant('alice', ['global'], ['global']);
const bob = grant('bob', ['global'], ['global']);
const carol = grant('carol', ['customer:x'], ['customer:x']);
const outsider = grant('mallory', [], []);
const root = createPrincipal({ id: 'root', superUser: true });
const context = { user: { username: 'request-user' } };
const ifMatch = (revision) => ({ ...context, headers: { 'if-match': `"${revision}"` } });
const ifNoneMatch = (value = '*') => ({ ...context, headers: { 'if-none-match': value } });

const idFor = (tag = 'default') => `mem-${String(tag).replace(/[^A-Za-z0-9_-]/g, '_')}--`.padEnd(16, '_');
const DEFAULT_ID = idFor('run-2026-09-28-a');

const stored = (id) => __test.stores.get('Memory').get(id);
const memoryRows = () => __test.stores.get('Memory');
const pinRows = () => __test.stores.get('MemoryPin');

const validInput = (overrides = {}) => ({
	title: 'Disk saturation on the east cluster',
	content: 'The database stalls when iowait passes 30%.',
	evidence: [{ kind: 'url', ref: 'https://tickets.example/4821' }],
	...overrides,
});

async function rejection(promise, statusCode, code) {
	const error = await promise.then(
		() => null,
		(reason) => reason,
	);
	assert.ok(error, 'expected the call to reject');
	assert.equal(error.statusCode, statusCode, error.message);
	if (code) assert.equal(error.code, code);
	return error;
}

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('create via putMemory', () => {
	it('defaults to private: one owner scope, revision 1, author provenance', async () => {
		const { id, revision, created, memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		assert.equal(id, DEFAULT_ID);
		assert.equal(revision, 1);
		assert.equal(created, true);
		assert.deepEqual(memory.scopes, ['user:alice']);
		assert.equal(memory.ownerId, 'alice');
		assert.equal(memory.status, 'active');
		assert.equal(memory.revision, 1);
		assert.equal(memory.author.principalId, 'alice');
		assert.equal(memory.lastEditor, null);
		assert.deepEqual(memory.evidence, [{ kind: 'url', ref: 'https://tickets.example/4821' }]);
		assert.deepEqual(memory.evidenceMemoryIds, []);
		assert.equal(stored(memory.id).embeddingModel, 'default');
		assert.ok(Array.isArray(stored(memory.id).embedding), 'the @embed hook ran on create');
		assert.equal(memory.embedding, undefined, 'the view never carries the vector');
		assert.equal(memory.durability, undefined);
		assert.equal(memory.pinned, undefined);
		assert.equal(stored(memory.id).idempotencyKey, undefined);
		assert.equal(stored(memory.id).createFingerprint, undefined);
	});

	it('validates the client-chosen id against ^[A-Za-z0-9_-]{16,64}$', async () => {
		for (const validId of [
			'a'.repeat(16),
			'Z'.repeat(64),
			'550e8400-e29b-41d4-a716-446655440000',
			'mem_id-0123456789',
		]) {
			const res = await putMemory(validId, validInput(), alice, context);
			assert.equal(res.id, validId);
			assert.equal(res.created, true);
		}
		for (const badId of [
			'',
			'short-id-15char',
			'a'.repeat(65),
			'invalid:character!',
			'has space inside16',
			null,
			123,
		]) {
			await rejection(putMemory(badId, validInput(), alice, context), 400, 'invalid_id');
		}
	});

	it('rejects server-derived and removed fields in the payload without echoing their names', async () => {
		for (const field of [
			'ownerId',
			'revision',
			'status',
			'author',
			'id',
			'createdAt',
			'embedding',
			'supersededBy',
			'evidenceMemoryIds',
			'durability',
			'pinned',
			'idempotencyKey',
			'createFingerprint',
			'expectedRevision',
		]) {
			await rejection(putMemory(DEFAULT_ID, validInput({ [field]: 'x' }), alice, context), 400, 'unsupported_fields');
		}
		const error = await rejection(
			putMemory(DEFAULT_ID, validInput({ synthetic_private_token: 'x' }), alice, context),
			400,
			'unsupported_fields',
		);
		assert.ok(!error.message.includes('synthetic_private_token'));
		assert.equal(memoryRows().size, 0);
	});

	it('bounds title, content and evidence before writing', async () => {
		await rejection(
			putMemory(DEFAULT_ID, validInput({ title: 'x'.repeat(201) }), alice, context),
			400,
			'title_too_long',
		);
		await rejection(
			putMemory(DEFAULT_ID, validInput({ content: 'x'.repeat(20_001) }), alice, context),
			400,
			'content_too_long',
		);
		const evidence = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({ kind: 'doc', ref: `ref-${i}` }));
		await rejection(putMemory(DEFAULT_ID, validInput({ evidence }), alice, context), 400, 'evidence_too_many');
		assert.equal(memoryRows().size, 0);
	});

	it('shared maps to global; explicit scopes win; every label must be writable', async () => {
		const shared = await putMemory(idFor('k1'), validInput({ visibility: 'shared' }), alice, context);
		assert.deepEqual(shared.memory.scopes, ['global']);
		assert.equal(shared.memory.ownerId, 'alice');

		const explicit = await putMemory(
			idFor('k2'),
			validInput({ scopes: ['customer:x'], visibility: 'shared' }),
			carol,
			context,
		);
		assert.deepEqual(explicit.memory.scopes, ['customer:x']);

		await rejection(
			putMemory(idFor('k3'), validInput({ scopes: ['customer:x'] }), alice, context),
			403,
			'scope_not_writable',
		);
		await rejection(putMemory(idFor('k4'), validInput({ visibility: 'shared' }), outsider, context), 403);
		await rejection(putMemory(idFor('k5'), validInput({ visibility: 'public' }), alice, context), 400);
	});

	it('honours If-None-Match: * for create-only PUT and rejects If-Match on an absent id', async () => {
		await rejection(putMemory(DEFAULT_ID, validInput(), alice, ifMatch(1)), 412, 'precondition_failed');
		const created = await putMemory(DEFAULT_ID, validInput(), alice, ifNoneMatch('*'));
		assert.equal(created.created, true);
		assert.equal(created.revision, 1);
		await rejection(putMemory(DEFAULT_ID, validInput(), alice, ifNoneMatch('*')), 412, 'precondition_failed');
	});
});

describe('idempotent retry and collisions on putMemory', () => {
	it('returns 200 with no write or sink call when editable fields equal the stored ones', async () => {
		const writes = [];
		const unregister = registerMemorySink({ write: (memory) => writes.push(memory.id) });
		try {
			const first = await putMemory(DEFAULT_ID, validInput({ tags: ['b', 'a'] }), alice, context);
			const retry = await putMemory(DEFAULT_ID, validInput({ tags: ['a', 'b'] }), alice, context);
			assert.equal(retry.created, false);
			assert.equal(retry.id, first.id);
			assert.equal(retry.revision, 1);
			assert.deepEqual(retry.memory.tags, ['a', 'b']);
			assert.equal(memoryRows().size, 1);
			assert.deepEqual(writes, [first.id]);
		} finally {
			unregister();
		}
	});

	it('accepts supersedes on an identical retry of a create that had the same supersedes, and rejects it on a revise', async () => {
		const old = await putMemory(idFor('old'), validInput({ visibility: 'shared' }), alice, context);
		const createPayload = validInput({ visibility: 'shared', supersedes: [old.id] });
		const first = await putMemory(idFor('next'), createPayload, alice, context);
		assert.equal(first.created, true);

		const retry = await putMemory(idFor('next'), createPayload, alice, context);
		assert.equal(retry.created, false);
		assert.equal(retry.revision, 1);

		await rejection(
			putMemory(idFor('next'), { ...createPayload, content: 'Revised body' }, alice, ifMatch(1)),
			400,
			'supersedes_not_allowed',
		);
		await rejection(putMemory(idFor('next'), createPayload, alice, ifMatch(1)), 400, 'supersedes_not_allowed');
		await rejection(
			putMemory(idFor('next'), { ...validInput({ visibility: 'shared' }), supersedes: [DEFAULT_ID] }, alice, context),
			400,
			'supersedes_not_allowed',
		);
	});

	it('requires If-Match when editable fields differ from the stored ones', async () => {
		const first = await putMemory(DEFAULT_ID, validInput(), alice, context);
		await rejection(
			putMemory(DEFAULT_ID, validInput({ content: 'Something else' }), alice, context),
			428,
			'if_match_required',
		);
		await rejection(
			putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context),
			428,
			'if_match_required',
		);
		assert.equal(stored(first.id).content, validInput().content);
	});

	it('distinguishes 403 not_memory_owner (readable) from 409 id_unavailable (unreadable)', async () => {
		await putMemory(idFor('shared-id'), validInput({ visibility: 'shared' }), alice, context);
		await putMemory(idFor('private-id'), validInput(), alice, context);

		await rejection(putMemory(idFor('shared-id'), validInput(), bob, context), 403, 'not_memory_owner');
		await rejection(putMemory(idFor('private-id'), validInput(), bob, context), 409, 'id_unavailable');
	});
});

describe('revise and scope changes', () => {
	it('keeps scopes and ownership when omitted, allows clearing validUntil with null, and bumps the revision once', async () => {
		const { memory } = await putMemory(
			DEFAULT_ID,
			validInput({ visibility: 'shared', validUntil: '2099-01-01T00:00:00.000Z' }),
			alice,
			context,
		);
		assert.equal(memory.validUntil, '2099-01-01T00:00:00.000Z');
		const revised = await putMemory(
			memory.id,
			{ content: 'The stall starts at 25%.', validUntil: null },
			alice,
			ifMatch(1),
		);
		assert.equal(revised.created, false);
		assert.equal(revised.revision, 2);
		assert.deepEqual(revised.memory.scopes, ['global']);
		assert.equal(revised.memory.ownerId, 'alice');
		assert.equal(revised.memory.title, memory.title);
		assert.equal(revised.memory.validUntil, null);
		assert.equal(revised.memory.author.principalId, 'alice');
		assert.equal(revised.memory.lastEditor.principalId, 'alice');
		assert.notEqual(revised.memory.updatedAt, memory.updatedAt);
		assert.equal(stored(memory.id).embeddingModel, 'default');
	});

	it('changes scopes only when asked, re-deriving rather than merging', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		const shared = await putMemory(memory.id, { visibility: 'shared' }, alice, ifMatch(1));
		assert.deepEqual(shared.memory.scopes, ['global']);
		const back = await putMemory(memory.id, { visibility: 'private' }, alice, ifMatch(2));
		assert.deepEqual(back.memory.scopes, ['user:alice']);
	});

	it('refuses a revision that would keep publishing to a label the owner can no longer write', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context);
		const demoted = grant('alice', ['global'], []);
		await rejection(putMemory(memory.id, { content: 'new' }, demoted, ifMatch(1)), 403, 'scope_not_writable');
		const narrowed = await putMemory(memory.id, { visibility: 'private' }, demoted, ifMatch(1));
		assert.deepEqual(narrowed.memory.scopes, ['user:alice']);
	});

	it('refuses to blank out a title or content, null scopes/visibility, and an empty payload', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		for (const field of ['title', 'content']) {
			await rejection(putMemory(memory.id, { [field]: '   ' }, alice, ifMatch(1)), 400, `${field}_required`);
		}
		await rejection(putMemory(memory.id, { scopes: null }, alice, ifMatch(1)), 400, 'invalid_scopes');
		await rejection(putMemory(memory.id, { visibility: null }, alice, ifMatch(1)), 400, 'invalid_visibility');
		await rejection(putMemory(memory.id, {}, alice, ifMatch(1)), 400, 'empty_payload');
		assert.equal(stored(memory.id).revision, 1);
	});
});

describe('If-Match preconditions', () => {
	it('rejects a stale revision with 412 and leaves the row unchanged', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		await putMemory(memory.id, { content: 'first edit' }, alice, ifMatch(1));
		await rejection(putMemory(memory.id, { content: 'stale' }, alice, ifMatch(1)), 412, 'precondition_failed');
		await rejection(withdrawMemory(memory.id, {}, alice, ifMatch(1)), 412, 'precondition_failed');
		assert.equal(stored(memory.id).content, 'first edit');
	});

	it('requires If-Match on every revise and withdrawal (428 if_match_required)', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		await rejection(putMemory(memory.id, { content: 'x' }, alice, context), 428, 'if_match_required');
		await rejection(withdrawMemory(memory.id, {}, alice, context), 428, 'if_match_required');
		for (const badHeader of ['1', 'W/"1"', '"2"', '"0"', 'invalid']) {
			await rejection(
				putMemory(memory.id, { content: 'x' }, alice, { ...context, headers: { 'if-match': badHeader } }),
				412,
				'precondition_failed',
			);
			await rejection(
				withdrawMemory(memory.id, {}, alice, { ...context, headers: { 'if-match': badHeader } }),
				412,
				'precondition_failed',
			);
		}
	});

	it('serialized concurrent writers: the second sees the first and gets 412', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		const results = await Promise.allSettled([
			putMemory(memory.id, { content: 'writer A' }, alice, ifMatch(1)),
			putMemory(memory.id, { content: 'writer B' }, alice, ifMatch(1)),
		]);
		assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
		const rejected = results.find((result) => result.status === 'rejected').reason;
		assert.equal(rejected.statusCode, 412);
		assert.equal(rejected.code, 'precondition_failed');
	});

	it('locks the row inside the lifecycle transaction before reading it', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		__test.lockLog.length = 0;
		await putMemory(memory.id, { content: 'locked' }, alice, ifMatch(1));
		assert.deepEqual(__test.lockLog, [{ table: 'Memory', id: memory.id, inTransaction: true }]);
	});
});

describe('ownership', () => {
	it('a reader who is not the owner gets 403; a non-reader gets 404 on withdraw and 409 on PUT', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context);
		await rejection(putMemory(memory.id, { content: 'bob was here' }, bob, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(withdrawMemory(memory.id, {}, bob, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(putMemory(memory.id, { content: 'outsider' }, outsider, ifMatch(1)), 409, 'id_unavailable');
		const hidden = await rejection(withdrawMemory(memory.id, {}, outsider, ifMatch(1)), 404, 'memory_not_found');
		const missing = await rejection(withdrawMemory('0'.repeat(32), {}, outsider, ifMatch(1)), 404);
		assert.equal(hidden.message, missing.message);
		assert.equal(stored(memory.id).revision, 1);
	});

	it('super_user edits any memory; a private shorthand resolves to the owner', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context);
		const revised = await putMemory(memory.id, { visibility: 'private' }, root, ifMatch(1));
		assert.deepEqual(revised.memory.scopes, ['user:alice']);
		assert.equal(revised.memory.ownerId, 'alice');
	});
});

describe('withdraw', () => {
	it('leaves a tombstone instead of deleting the row', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		const withdrawn = await withdrawMemory(memory.id, { reason: 'obsolete' }, alice, ifMatch(1));
		assert.equal(withdrawn.status, 'withdrawn');
		assert.equal(withdrawn.revision, 2);
		assert.ok(withdrawn.withdrawnAt);
		assert.equal(withdrawn.withdrawnReason, 'obsolete');
		assert.equal(stored(memory.id).ownerId, 'alice');
	});

	it('refuses further mutation of a withdrawn memory', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		await withdrawMemory(memory.id, {}, alice, ifMatch(1));
		await rejection(putMemory(memory.id, { content: 'x' }, alice, ifMatch(2)), 409, 'memory_withdrawn');
		await rejection(withdrawMemory(memory.id, {}, alice, ifMatch(2)), 409, 'memory_withdrawn');
	});

	it('hides a withdrawn shared memory from everyone but its owner', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context);
		await withdrawMemory(memory.id, {}, alice, ifMatch(1));
		assert.equal(await getMemory(memory.id, bob), undefined);
		assert.equal((await getMemory(memory.id, alice)).status, 'withdrawn');
	});
});

describe('supersede', () => {
	const shared = (overrides = {}) => validInput({ visibility: 'shared', ...overrides });

	it('marks the old memory superseded in the same transaction', async () => {
		const old = (await putMemory(idFor('v1'), shared(), alice, context)).memory;
		const next = (await putMemory(idFor('v2'), shared({ supersedes: [old.id] }), bob, context)).memory;
		assert.deepEqual(next.supersedes, [old.id]);
		const after = await getMemory(old.id, alice);
		assert.equal(after.status, 'superseded');
		assert.equal(after.supersededBy, next.id);
		assert.equal(after.revision, 2);
	});

	it('requires reading the old memory (identical 404) and covering its scopes', async () => {
		const secret = (await putMemory(idFor('secret'), validInput(), alice, context)).memory;
		await rejection(
			putMemory(idFor('probe'), shared({ supersedes: [secret.id] }), bob, context),
			404,
			'memory_not_found',
		);
		const customer = (await putMemory(idFor('cx'), validInput({ scopes: ['customer:x'] }), carol, context)).memory;
		const root2 = await rejection(
			putMemory(idFor('narrow'), shared({ supersedes: [customer.id] }), root, context),
			403,
		);
		assert.equal(root2.code, 'supersede_scope_narrowing');
		assert.equal((await getMemory(customer.id, carol)).status, 'active');
	});

	it('refuses to supersede a withdrawn memory', async () => {
		const old = (await putMemory(idFor('v1'), shared(), alice, context)).memory;
		await withdrawMemory(old.id, {}, alice, ifMatch(1));
		await rejection(putMemory(idFor('v2'), shared({ supersedes: [old.id] }), root, context), 409, 'memory_withdrawn');
	});

	it('freezes a superseded memory except for withdrawal', async () => {
		const old = (await putMemory(idFor('v1'), shared(), alice, context)).memory;
		await putMemory(idFor('v2'), shared({ supersedes: [old.id] }), bob, context);
		await rejection(putMemory(old.id, { content: 'edit' }, alice, ifMatch(2)), 409, 'memory_superseded');
		await rejection(putMemory(old.id, { visibility: 'private' }, alice, ifMatch(2)), 409, 'memory_superseded');
		assert.equal((await withdrawMemory(old.id, {}, alice, ifMatch(2))).status, 'withdrawn');
	});

	it('keeps the superseder covering what it superseded', async () => {
		const old = (await putMemory(idFor('v1'), shared(), alice, context)).memory;
		const next = (await putMemory(idFor('v2'), shared({ supersedes: [old.id] }), alice, context)).memory;
		await rejection(putMemory(next.id, { visibility: 'private' }, alice, ifMatch(1)), 403, 'supersede_scope_narrowing');
	});

	it('withdrawing the only superseder restores the old memory', async () => {
		const old = (await putMemory(idFor('v1'), shared(), alice, context)).memory;
		const next = (await putMemory(idFor('v2'), shared({ supersedes: [old.id] }), bob, context)).memory;
		await withdrawMemory(next.id, {}, bob, ifMatch(1));
		const restored = await getMemory(old.id, alice);
		assert.equal(restored.status, 'active');
		assert.equal(restored.supersededBy, null);
		assert.equal(restored.revision, 3);
	});

	it('stays superseded while another non-withdrawn memory supersedes it, newest first', async () => {
		const old = (await putMemory(idFor('t'), shared(), alice, context)).memory;
		const b = (await putMemory(idFor('b'), shared({ supersedes: [old.id] }), bob, context)).memory;
		const c = (await putMemory(idFor('c'), shared({ supersedes: [old.id] }), bob, context)).memory;
		assert.equal((await getMemory(old.id, alice)).supersededBy, c.id);
		// c is itself superseded by d: it still carries the chain, so withdrawing b must not restore old.
		await putMemory(idFor('d'), shared({ supersedes: [c.id] }), bob, context);
		await withdrawMemory(b.id, {}, bob, ifMatch(1));
		const afterB = await getMemory(old.id, alice);
		assert.equal(afterB.status, 'superseded');
		assert.equal(afterB.supersededBy, c.id);
		await withdrawMemory(c.id, {}, bob, ifMatch(2));
		assert.equal((await getMemory(old.id, alice)).status, 'active');
	});

	it('recomputes a target whose pointer names a different superseder', async () => {
		const old = (await putMemory(idFor('t'), shared(), alice, context)).memory;
		const b = (await putMemory(idFor('b'), shared({ supersedes: [old.id] }), bob, context)).memory;
		const c = (await putMemory(idFor('c'), shared({ supersedes: [old.id] }), bob, context)).memory;
		await withdrawMemory(c.id, {}, bob, ifMatch(1));
		assert.equal((await getMemory(old.id, alice)).supersededBy, b.id);
		await withdrawMemory(b.id, {}, bob, ifMatch(1));
		assert.equal((await getMemory(old.id, alice)).status, 'active');
	});
});

describe('supersede bookkeeping at scale and under contention', () => {
	const shared = (overrides = {}) => validInput({ visibility: 'shared', ...overrides });

	it('takes every lock a withdrawal needs once, in sorted order, and retries if supersedes appeared after pre-read', async () => {
		const old = (await putMemory(idFor('t'), shared(), alice, context)).memory;
		const next = (await putMemory(idFor('n'), shared({ supersedes: [old.id] }), alice, context)).memory;
		__test.lockLog.length = 0;
		await withdrawMemory(next.id, {}, alice, ifMatch(1));
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[old.id, next.id].sort(),
		);

		const old2 = (await putMemory(idFor('t2'), shared(), alice, context)).memory;
		const next2 = (await putMemory(idFor('n2'), shared({ supersedes: [old2.id] }), alice, context)).memory;
		const Memory = databases.memory.Memory;
		const originalGet = Memory.get.bind(Memory);
		let preRead = true;
		Memory.get = async (id, ctx) => {
			if (preRead && id === next2.id && !ctx?.transaction) {
				preRead = false;
				return undefined;
			}
			return originalGet(id, ctx);
		};
		__test.lockLog.length = 0;
		try {
			await withdrawMemory(next2.id, {}, alice, ifMatch(1));
		} finally {
			Memory.get = originalGet;
		}
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[next2.id, ...[old2.id, next2.id].sort()],
		);
	});

	it('keeps a target superseded while any of more than 100 superseders remains', async () => {
		const old = (await putMemory(idFor('t'), shared(), alice, context)).memory;
		const holders = [];
		for (let i = 0; i < 101; i++)
			holders.push((await putMemory(idFor(`h${i}`), shared({ supersedes: [old.id] }), bob, context)).memory);
		for (const holder of holders.slice(0, 100)) await withdrawMemory(holder.id, {}, bob, ifMatch(1));
		const still = await getMemory(old.id, alice);
		assert.equal(still.status, 'superseded');
		assert.equal(still.supersededBy, holders[100].id);
		await withdrawMemory(holders[100].id, {}, bob, ifMatch(1));
		assert.equal((await getMemory(old.id, alice)).status, 'active');
	});
});

describe('sinks', () => {
	it('see every changed row inside the lifecycle transaction, with its context', async () => {
		const calls = [];
		const unregister = registerMemorySink({
			write: (memory, txnContext) => calls.push(['write', memory.id, memory.status, Boolean(txnContext.transaction)]),
			withdraw: (memory, txnContext) =>
				calls.push(['withdraw', memory.id, memory.status, Boolean(txnContext.transaction)]),
		});
		try {
			const old = (await putMemory(idFor('o'), validInput({ visibility: 'shared' }), alice, context)).memory;
			const next = (
				await putMemory(idFor('n'), validInput({ visibility: 'shared', supersedes: [old.id] }), bob, context)
			).memory;
			await withdrawMemory(next.id, {}, bob, ifMatch(1));
			assert.deepEqual(calls, [
				['write', old.id, 'active', true],
				['write', next.id, 'active', true],
				['write', old.id, 'superseded', true],
				['withdraw', next.id, 'withdrawn', true],
				['write', old.id, 'active', true],
			]);
		} finally {
			unregister();
		}
	});

	it('a sink unregistered during dispatch does not cost another sink its call', async () => {
		const calls = [];
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		const unregisterA = registerMemorySink({
			async write() {
				calls.push('a');
				await gate;
			},
		});
		const unregisterB = registerMemorySink({ write: () => calls.push('b') });
		try {
			const pending = putMemory(DEFAULT_ID, validInput(), alice, context);
			await new Promise((resolve) => setImmediate(resolve));
			unregisterA();
			release();
			await pending;
			assert.deepEqual(calls, ['a', 'b']);
		} finally {
			unregisterA();
			unregisterB();
		}
	});

	it('a throwing sink rolls back the memory and its supersede side effect', async () => {
		const old = (await putMemory(idFor('o'), validInput({ visibility: 'shared' }), alice, context)).memory;
		const unregister = registerMemorySink({
			write() {
				throw new Error('handoff rejected');
			},
		});
		try {
			await assert.rejects(
				putMemory(idFor('n'), validInput({ visibility: 'shared', supersedes: [old.id] }), bob, context),
				/handoff rejected/,
			);
		} finally {
			unregister();
		}
		assert.equal(memoryRows().size, 1);
		assert.equal(stored(old.id).status, 'active');
	});
});

describe('embedding model', () => {
	it('embeds each write once, before taking any lock, with the configured model, and tags the row with it', async () => {
		applySettings(parseSettings({ embeddingModel: 'local:small' }));
		const embed = models.embed;
		let locksAtEmbed;
		models.embed = (input, options) => {
			locksAtEmbed = __test.lockLog.length;
			return embed.call(models, input, options);
		};
		__test.lockLog.length = 0;
		let memory;
		try {
			({ memory } = await putMemory(idFor('k2'), validInput(), alice, context));
		} finally {
			models.embed = embed;
		}
		assert.equal(locksAtEmbed, 0);
		assert.deepEqual(
			models.calls.map((call) => call.options),
			[{ model: 'local:small', inputType: 'document' }],
		);
		assert.equal(stored(memory.id).embeddingModel, 'local:small');
		assert.deepEqual(
			stored(memory.id).embedding,
			Array.from(Float32Array.from(__test.embedText(validInput().content))),
		);
		assert.deepEqual(__test.setEmbedCalls, [{ table: 'Memory', attribute: 'embedding' }]);
	});

	it('keeps the stored vector when a revise leaves the content and model unchanged', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		models.calls.length = 0;
		await putMemory(memory.id, { content: validInput().content, tags: ['ops'] }, alice, ifMatch(1));
		assert.equal(models.calls.length, 0);
		assert.deepEqual(stored(memory.id).tags, ['ops']);
		applySettings(parseSettings({ embeddingModel: 'local:small' }));
		await putMemory(memory.id, { content: validInput().content, tags: ['ops', 'disk'] }, alice, ifMatch(2));
		assert.equal(models.calls.length, 1, 'a new model re-embeds even unchanged content');
		assert.equal(stored(memory.id).embeddingModel, 'local:small');
	});
});

describe('typed evidence and evidenceMemoryIds', () => {
	it('accepts all six kinds, derives deduplicated evidenceMemoryIds, and indexes them for search', async () => {
		const m1 = (await putMemory(idFor('m1'), validInput({ visibility: 'shared' }), alice, context)).memory;
		const m2 = (await putMemory(idFor('m2'), validInput(), bob, context)).memory;
		const evidence = [
			{ kind: 'memory', ref: m1.id, note: 'shared antecedent' },
			{ kind: 'memory', ref: m1.id, note: 'duplicate ref still deduplicates evidenceMemoryIds' },
			{ kind: 'memory', ref: m2.id },
			{ kind: 'doc', ref: 'DESIGN.md#lifecycle' },
			{ kind: 'pr', ref: 'HarperFast/agent-memory#5' },
			{ kind: 'commit', ref: '3113fb8' },
			{ kind: 'url', ref: 'https://tickets.example/4821' },
			{ kind: 'text', ref: 'observed in staging logs', note: 'east-1' },
		];
		const { memory } = await putMemory(idFor('citing'), validInput({ evidence }), bob, context);
		assert.deepEqual(memory.evidence, evidence);
		assert.deepEqual(memory.evidenceMemoryIds, [m1.id, m2.id]);
		assert.deepEqual(stored(memory.id).evidenceMemoryIds, [m1.id, m2.id]);

		const dependents = [];
		for await (const row of databases.memory.Memory.search({
			conditions: [{ attribute: 'evidenceMemoryIds', comparator: 'equals', value: m1.id }],
		})) {
			dependents.push(row.id);
		}
		assert.deepEqual(dependents, [memory.id]);

		const revised = await putMemory(memory.id, { evidence: [{ kind: 'memory', ref: m2.id }] }, bob, ifMatch(1));
		assert.deepEqual(revised.memory.evidenceMemoryIds, [m2.id]);
		assert.deepEqual(stored(memory.id).evidenceMemoryIds, [m2.id]);
	});

	it('rejects unreadable, missing, or malformed memory-kind refs with the same 400 invalid_evidence on create and revise', async () => {
		const secret = (await putMemory(idFor('secret'), validInput(), alice, context)).memory;
		const withdrawn = (await putMemory(idFor('withdrawn'), validInput({ visibility: 'shared' }), alice, context))
			.memory;
		await withdrawMemory(withdrawn.id, {}, alice, ifMatch(1));
		const missingId = '0'.repeat(32);

		const unreadableErr = await rejection(
			putMemory(idFor('probe-1'), validInput({ evidence: [{ kind: 'memory', ref: secret.id }] }), bob, context),
			400,
			'invalid_evidence',
		);
		const missingErr = await rejection(
			putMemory(idFor('probe-2'), validInput({ evidence: [{ kind: 'memory', ref: missingId }] }), bob, context),
			400,
			'invalid_evidence',
		);
		const withdrawnErr = await rejection(
			putMemory(idFor('probe-3'), validInput({ evidence: [{ kind: 'memory', ref: withdrawn.id }] }), bob, context),
			400,
			'invalid_evidence',
		);
		const malformedErr = await rejection(
			putMemory(idFor('probe-4'), validInput({ evidence: [{ kind: 'memory', ref: 'short' }] }), bob, context),
			400,
			'invalid_evidence',
		);
		assert.equal(unreadableErr.message, missingErr.message);
		assert.equal(withdrawnErr.message, missingErr.message);
		assert.equal(malformedErr.message, missingErr.message);

		const bobs = (await putMemory(idFor('bobs'), validInput(), bob, context)).memory;
		const reviseUnreadable = await rejection(
			putMemory(bobs.id, { evidence: [{ kind: 'memory', ref: secret.id }] }, bob, ifMatch(1)),
			400,
			'invalid_evidence',
		);
		const reviseMissing = await rejection(
			putMemory(bobs.id, { evidence: [{ kind: 'memory', ref: missingId }] }, bob, ifMatch(1)),
			400,
			'invalid_evidence',
		);
		assert.equal(reviseUnreadable.message, reviseMissing.message);
		assert.equal(stored(bobs.id).revision, 1);
	});

	it('validates evidence item shape and length bounds', async () => {
		for (const bad of [
			'not-an-array',
			['legacy-string'],
			[null],
			[{ kind: 'issue', ref: '123' }],
			[{ kind: 'url', ref: '   ' }],
			[{ kind: 'url', ref: 'https://example.com', note: '   ' }],
			[{ kind: 'url', ref: 'https://example.com', extra: true }],
		]) {
			await rejection(putMemory(DEFAULT_ID, validInput({ evidence: bad }), alice, context), 400, 'invalid_evidence');
		}
		await rejection(
			putMemory(
				DEFAULT_ID,
				validInput({ evidence: [{ kind: 'url', ref: 'x'.repeat(EVIDENCE_REF_MAX_CHARS + 1) }] }),
				alice,
				context,
			),
			400,
			'evidence_too_long',
		);
		await rejection(
			putMemory(
				DEFAULT_ID,
				validInput({
					evidence: [{ kind: 'url', ref: 'https://example.com', note: 'x'.repeat(EVIDENCE_NOTE_MAX_CHARS + 1) }],
				}),
				alice,
				context,
			),
			400,
			'evidence_too_long',
		);
	});
});

describe('pin and unpin', () => {
	it('records a per-reader MemoryPin row, is idempotent, and unpins without touching other readers', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput({ visibility: 'shared' }), alice, context);
		const first = await pinMemory(memory.id, {}, bob, context);
		assert.equal(first.pinned, true);
		assert.equal(first.memoryId, memory.id);
		assert.equal(first.memory.id, memory.id);
		assert.ok(pinRows().has(`bob:${memory.id}`));

		const createdAt = pinRows().get(`bob:${memory.id}`).createdAt;
		const second = await pinMemory(memory.id, {}, bob, context);
		assert.equal(second.pinned, true);
		assert.equal(pinRows().get(`bob:${memory.id}`).createdAt, createdAt);

		await pinMemory(memory.id, {}, alice, context);
		assert.equal(pinRows().size, 2);

		const unpinned = await unpinMemory(memory.id, {}, bob, context);
		assert.equal(unpinned.pinned, false);
		assert.equal(unpinned.memoryId, memory.id);
		assert.equal(pinRows().has(`bob:${memory.id}`), false);
		assert.equal(pinRows().has(`alice:${memory.id}`), true);

		const again = await unpinMemory(memory.id, {}, bob, context);
		assert.equal(again.pinned, false);
	});

	it('returns the same 404 on pin and the same memory-less response on unpin for unreadable and missing ids, and unpins descoped pins', async () => {
		const secret = (await putMemory(idFor('secret'), validInput(), alice, context)).memory;
		const missingId = '0'.repeat(32);

		const pinHidden = await rejection(pinMemory(secret.id, {}, bob, context), 404, 'memory_not_found');
		const pinMissing = await rejection(pinMemory(missingId, {}, bob, context), 404, 'memory_not_found');
		assert.equal(pinHidden.message, pinMissing.message);

		const unpinHidden = await unpinMemory(secret.id, {}, bob, context);
		const unpinMissing = await unpinMemory(missingId, {}, bob, context);
		assert.deepEqual(unpinHidden, { pinned: false, memoryId: secret.id });
		assert.deepEqual(unpinMissing, { pinned: false, memoryId: missingId });
		assert.equal(pinRows().size, 0);

		const shared = (await putMemory(idFor('shared'), validInput({ visibility: 'shared' }), alice, context)).memory;
		await pinMemory(shared.id, {}, bob, context);
		assert.equal(pinRows().has(`bob:${shared.id}`), true);
		await putMemory(shared.id, validInput({ visibility: 'private' }), alice, ifMatch(1));
		const unpinnedDescoped = await unpinMemory(shared.id, {}, bob, context);
		assert.deepEqual(unpinnedDescoped, { pinned: false, memoryId: shared.id });
		assert.equal(pinRows().has(`bob:${shared.id}`), false);
	});

	it('rejects unknown fields in pin and unpin payloads', async () => {
		const { memory } = await putMemory(DEFAULT_ID, validInput(), alice, context);
		await rejection(pinMemory(memory.id, { pinned: true }, alice, context), 400, 'unsupported_fields');
		await rejection(unpinMemory(memory.id, { pinned: false }, alice, context), 400, 'unsupported_fields');
	});

	it('caps pins per principal at 50, locks the principal key, and prunes only withdrawn pins before rejecting', async () => {
		const memories = [];
		for (let i = 0; i < BOOTSTRAP_PINNED_LIMIT; i++) {
			const { memory } = await putMemory(idFor(`pin-${i}`), validInput(), alice, context);
			memories.push(memory);
			await pinMemory(memory.id, {}, alice, context);
		}
		// Supersede pin-1 and expire pin-2: neither is terminal, so neither may be silently pruned at the cap.
		await putMemory(idFor('superseder'), validInput({ supersedes: [memories[1].id] }), alice, context);
		await putMemory(memories[2].id, { validUntil: '2020-01-01T00:00:00.000Z' }, alice, {
			headers: { 'if-match': '*' },
		});

		const extra = (await putMemory(idFor('pin-extra'), validInput(), alice, context)).memory;
		await rejection(pinMemory(extra.id, {}, alice, context), 409, 'pin_limit_exceeded');
		assert.equal(pinRows().has(`alice:${memories[1].id}`), true);
		assert.equal(pinRows().has(`alice:${memories[2].id}`), true);

		await withdrawMemory(memories[0].id, {}, alice, { headers: { 'if-match': '*' } });
		__test.lockLog.length = 0;
		const pinnedExtra = await pinMemory(extra.id, {}, alice, context);
		assert.equal(pinnedExtra.pinned, true);
		assert.equal(pinRows().has(`alice:${memories[0].id}`), false);
		assert.equal(pinRows().has(`alice:${extra.id}`), true);
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			['alice', `alice:${extra.id}`],
		);
	});
});
