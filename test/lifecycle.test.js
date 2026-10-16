import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases, models } from 'harper';
import {
	BOOTSTRAP_PINNED_LIMIT,
	createMemory,
	EVIDENCE_MAX_ITEMS,
	EVIDENCE_NOTE_MAX_CHARS,
	EVIDENCE_REF_MAX_CHARS,
	getMemory,
	memoryIdFor,
	pinMemory,
	reviseMemory,
	setMemoryScopes,
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

const stored = (id) => __test.stores.get('Memory').get(id);
const memoryRows = () => __test.stores.get('Memory');
const pinRows = () => __test.stores.get('MemoryPin');

const validInput = (overrides = {}) => ({
	title: 'Disk saturation on the east cluster',
	content: 'The database stalls when iowait passes 30%.',
	evidence: [{ kind: 'url', ref: 'https://tickets.example/4821' }],
	idempotencyKey: 'run-2026-09-28-a',
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

describe('create', () => {
	it('defaults to private: one owner scope, revision 1, author provenance', async () => {
		const { memory, created } = await createMemory(validInput(), alice, context);
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
	});

	it('derives the id from the principal and idempotency key, not the payload', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		assert.equal(memory.id, memoryIdFor('alice', 'run-2026-09-28-a'));
		assert.notEqual(memoryIdFor('bob', 'run-2026-09-28-a'), memory.id);
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
		]) {
			await rejection(createMemory(validInput({ [field]: 'x' }), alice, context), 400, 'unsupported_fields');
		}
		const error = await rejection(
			createMemory(validInput({ synthetic_private_token: 'x' }), alice, context),
			400,
			'unsupported_fields',
		);
		assert.ok(!error.message.includes('synthetic_private_token'));
		assert.equal(memoryRows().size, 0);
	});

	it('requires an idempotency key and refuses the reserved import prefix', async () => {
		await rejection(
			createMemory(validInput({ idempotencyKey: undefined }), alice, context),
			400,
			'idempotencyKey_required',
		);
		await rejection(
			createMemory(validInput({ idempotencyKey: 'import:flair:1' }), alice, context),
			400,
			'reserved_idempotency_key',
		);
	});

	it('bounds title, content and evidence before writing', async () => {
		await rejection(createMemory(validInput({ title: 'x'.repeat(201) }), alice, context), 400, 'title_too_long');
		await rejection(createMemory(validInput({ content: 'x'.repeat(20_001) }), alice, context), 400, 'content_too_long');
		const evidence = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({ kind: 'doc', ref: `ref-${i}` }));
		await rejection(createMemory(validInput({ evidence }), alice, context), 400, 'evidence_too_many');
		assert.equal(memoryRows().size, 0);
	});

	it('shared maps to global; explicit scopes win; every label must be writable', async () => {
		const shared = await createMemory(validInput({ visibility: 'shared' }), alice, context);
		assert.deepEqual(shared.memory.scopes, ['global']);
		assert.equal(shared.memory.ownerId, 'alice');

		const explicit = await createMemory(
			validInput({ idempotencyKey: 'k2', scopes: ['customer:x'], visibility: 'shared' }),
			carol,
			context,
		);
		assert.deepEqual(explicit.memory.scopes, ['customer:x']);

		await rejection(
			createMemory(validInput({ idempotencyKey: 'k3', scopes: ['customer:x'] }), alice, context),
			403,
			'scope_not_writable',
		);
		await rejection(createMemory(validInput({ idempotencyKey: 'k4', visibility: 'shared' }), outsider, context), 403);
		await rejection(createMemory(validInput({ idempotencyKey: 'k5', visibility: 'public' }), alice, context), 400);
	});
});

describe('idempotent create', () => {
	it('returns the existing row on a matching retry, without a second row or sink call', async () => {
		const writes = [];
		const unregister = registerMemorySink({ write: (memory) => writes.push(memory.id) });
		try {
			const first = await createMemory(validInput({ tags: ['b', 'a'] }), alice, context);
			const retry = await createMemory(validInput({ tags: ['a', 'b'] }), alice, context);
			assert.equal(retry.created, false);
			assert.equal(retry.memory.id, first.memory.id);
			assert.deepEqual(retry.memory.tags, ['a', 'b']);
			assert.equal(memoryRows().size, 1);
			assert.deepEqual(writes, [first.memory.id]);
		} finally {
			unregister();
		}
	});

	it('fails a conflicting retry with 409 and leaves the row alone', async () => {
		const first = await createMemory(validInput(), alice, context);
		await rejection(
			createMemory(validInput({ content: 'Something else' }), alice, context),
			409,
			'idempotency_conflict',
		);
		await rejection(createMemory(validInput({ visibility: 'shared' }), alice, context), 409, 'idempotency_conflict');
		assert.equal(stored(first.memory.id).content, validInput().content);
	});

	it('still matches a late retry of the original create after a revision', async () => {
		const first = await createMemory(validInput(), alice, context);
		await reviseMemory(first.memory.id, { content: 'Revised body', expectedRevision: 1 }, alice, context);
		const retry = await createMemory(validInput(), alice, context);
		assert.equal(retry.created, false);
		assert.equal(retry.memory.revision, 2);
		assert.equal(retry.memory.content, 'Revised body');
	});

	it('is scoped per principal', async () => {
		await createMemory(validInput(), alice, context);
		await createMemory(validInput(), bob, context);
		assert.equal(memoryRows().size, 2);
	});
});

describe('revise and scope changes', () => {
	it('keeps scopes and ownership when omitted, allows clearing validUntil with null, and bumps the revision once', async () => {
		const { memory } = await createMemory(
			validInput({ visibility: 'shared', validUntil: '2099-01-01T00:00:00.000Z' }),
			alice,
			context,
		);
		assert.equal(memory.validUntil, '2099-01-01T00:00:00.000Z');
		const revised = await reviseMemory(
			memory.id,
			{ content: 'The stall starts at 25%.', validUntil: null, expectedRevision: 1 },
			alice,
			context,
		);
		assert.equal(revised.revision, 2);
		assert.deepEqual(revised.scopes, ['global']);
		assert.equal(revised.ownerId, 'alice');
		assert.equal(revised.title, memory.title);
		assert.equal(revised.validUntil, null);
		assert.equal(revised.author.principalId, 'alice');
		assert.equal(revised.lastEditor.principalId, 'alice');
		assert.notEqual(revised.updatedAt, memory.updatedAt);
		assert.equal(stored(memory.id).embeddingModel, 'default');
	});

	it('changes scopes only when asked, re-deriving rather than merging', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		const shared = await setMemoryScopes(memory.id, { visibility: 'shared', expectedRevision: 1 }, alice, context);
		assert.deepEqual(shared.scopes, ['global']);
		const back = await setMemoryScopes(memory.id, { visibility: 'private', expectedRevision: 2 }, alice, context);
		assert.deepEqual(back.scopes, ['user:alice']);
	});

	it('refuses a revision that would keep publishing to a label the owner can no longer write', async () => {
		const { memory } = await createMemory(validInput({ visibility: 'shared' }), alice, context);
		const demoted = grant('alice', ['global'], []);
		await rejection(
			reviseMemory(memory.id, { content: 'new', expectedRevision: 1 }, demoted, context),
			403,
			'scope_not_writable',
		);
		const narrowed = await setMemoryScopes(memory.id, { visibility: 'private', expectedRevision: 1 }, demoted, context);
		assert.deepEqual(narrowed.scopes, ['user:alice']);
	});

	it('the scopes route accepts scopes, visibility and expectedRevision only', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		for (const forged of [{ ownerId: 'bob' }, { title: 'rewritten' }, { content: 'rewritten' }, { revision: 99 }]) {
			await rejection(
				setMemoryScopes(memory.id, { visibility: 'shared', expectedRevision: 1, ...forged }, alice, context),
				400,
				'unsupported_fields',
			);
		}
		for (const bad of [null, 'shared', ['shared'], 7]) {
			await rejection(setMemoryScopes(memory.id, bad, alice, context), 400, 'invalid_payload');
		}
		assert.equal(stored(memory.id).revision, 1);
	});

	it('refuses to blank out a title or content, null scopes/visibility, and an empty revision', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		for (const field of ['title', 'content']) {
			await rejection(
				reviseMemory(memory.id, { [field]: '   ', expectedRevision: 1 }, alice, context),
				400,
				`${field}_required`,
			);
		}
		await rejection(
			reviseMemory(memory.id, { scopes: null, expectedRevision: 1 }, alice, context),
			400,
			'invalid_scopes',
		);
		await rejection(
			reviseMemory(memory.id, { visibility: null, expectedRevision: 1 }, alice, context),
			400,
			'invalid_visibility',
		);
		await rejection(reviseMemory(memory.id, { expectedRevision: 1 }, alice, context), 400, 'empty_revision');
		assert.equal(stored(memory.id).revision, 1);
	});
});

describe('expected revision', () => {
	it('rejects a stale revision and leaves the row unchanged', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		await reviseMemory(memory.id, { content: 'first edit', expectedRevision: 1 }, alice, context);
		await rejection(
			reviseMemory(memory.id, { content: 'stale', expectedRevision: 1 }, alice, context),
			409,
			'revision_conflict',
		);
		assert.equal(stored(memory.id).content, 'first edit');
	});

	it('is required on every mutation', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		for (const bad of [undefined, null, 0, -1, '1', 1.5]) {
			await rejection(
				reviseMemory(memory.id, { content: 'x', expectedRevision: bad }, alice, context),
				400,
				'expected_revision_required',
			);
			await rejection(
				withdrawMemory(memory.id, { expectedRevision: bad }, alice, context),
				400,
				'expected_revision_required',
			);
		}
	});

	it('serialized concurrent writers: the second sees the first and gets 409', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		const results = await Promise.allSettled([
			reviseMemory(memory.id, { content: 'writer A', expectedRevision: 1 }, alice, context),
			reviseMemory(memory.id, { content: 'writer B', expectedRevision: 1 }, alice, context),
		]);
		assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
		assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'revision_conflict');
	});

	it('locks the row inside the lifecycle transaction before reading it', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		__test.lockLog.length = 0;
		await reviseMemory(memory.id, { content: 'locked', expectedRevision: 1 }, alice, context);
		assert.deepEqual(__test.lockLog, [{ table: 'Memory', id: memory.id, inTransaction: true }]);
	});
});

describe('ownership', () => {
	it('a reader who is not the owner gets 403; a non-reader gets the same 404 as a missing id', async () => {
		const { memory } = await createMemory(validInput({ visibility: 'shared' }), alice, context);
		await rejection(
			reviseMemory(memory.id, { content: 'bob was here', expectedRevision: 1 }, bob, context),
			403,
			'not_memory_owner',
		);
		await rejection(withdrawMemory(memory.id, { expectedRevision: 1 }, bob, context), 403, 'not_memory_owner');
		const hidden = await rejection(
			withdrawMemory(memory.id, { expectedRevision: 1 }, outsider, context),
			404,
			'memory_not_found',
		);
		const missing = await rejection(withdrawMemory('0'.repeat(32), { expectedRevision: 1 }, outsider, context), 404);
		assert.equal(hidden.message, missing.message);
		assert.equal(stored(memory.id).revision, 1);
	});

	it('super_user edits any memory; a private shorthand resolves to the owner', async () => {
		const { memory } = await createMemory(validInput({ visibility: 'shared' }), alice, context);
		const revised = await setMemoryScopes(memory.id, { visibility: 'private', expectedRevision: 1 }, root, context);
		assert.deepEqual(revised.scopes, ['user:alice']);
		assert.equal(revised.ownerId, 'alice');
	});
});

describe('withdraw', () => {
	it('leaves a tombstone instead of deleting the row', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		const withdrawn = await withdrawMemory(memory.id, { expectedRevision: 1, reason: 'obsolete' }, alice, context);
		assert.equal(withdrawn.status, 'withdrawn');
		assert.equal(withdrawn.revision, 2);
		assert.ok(withdrawn.withdrawnAt);
		assert.equal(withdrawn.withdrawnReason, 'obsolete');
		assert.equal(stored(memory.id).ownerId, 'alice');
	});

	it('refuses further mutation of a withdrawn memory', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		await withdrawMemory(memory.id, { expectedRevision: 1 }, alice, context);
		await rejection(
			reviseMemory(memory.id, { content: 'x', expectedRevision: 2 }, alice, context),
			409,
			'memory_withdrawn',
		);
		await rejection(withdrawMemory(memory.id, { expectedRevision: 2 }, alice, context), 409, 'memory_withdrawn');
	});

	it('hides a withdrawn shared memory from everyone but its owner', async () => {
		const { memory } = await createMemory(validInput({ visibility: 'shared' }), alice, context);
		await withdrawMemory(memory.id, { expectedRevision: 1 }, alice, context);
		assert.equal(await getMemory(memory.id, bob), undefined);
		assert.equal((await getMemory(memory.id, alice)).status, 'withdrawn');
	});
});

describe('supersede', () => {
	const shared = (key, overrides = {}) => validInput({ idempotencyKey: key, visibility: 'shared', ...overrides });

	it('marks the old memory superseded in the same transaction', async () => {
		const old = (await createMemory(shared('v1'), alice, context)).memory;
		const next = (await createMemory(shared('v2', { supersedes: [old.id] }), bob, context)).memory;
		assert.deepEqual(next.supersedes, [old.id]);
		const after = await getMemory(old.id, alice);
		assert.equal(after.status, 'superseded');
		assert.equal(after.supersededBy, next.id);
		assert.equal(after.revision, 2);
	});

	it('requires reading the old memory (identical 404) and covering its scopes', async () => {
		const secret = (await createMemory(validInput({ idempotencyKey: 'secret' }), alice, context)).memory;
		await rejection(createMemory(shared('probe', { supersedes: [secret.id] }), bob, context), 404, 'memory_not_found');
		const customer = (await createMemory(validInput({ idempotencyKey: 'cx', scopes: ['customer:x'] }), carol, context))
			.memory;
		const root2 = await rejection(createMemory(shared('narrow', { supersedes: [customer.id] }), root, context), 403);
		assert.equal(root2.code, 'supersede_scope_narrowing');
		assert.equal((await getMemory(customer.id, carol)).status, 'active');
	});

	it('refuses to supersede a withdrawn memory', async () => {
		const old = (await createMemory(shared('v1'), alice, context)).memory;
		await withdrawMemory(old.id, { expectedRevision: 1 }, alice, context);
		await rejection(createMemory(shared('v2', { supersedes: [old.id] }), root, context), 409, 'memory_withdrawn');
	});

	it('freezes a superseded memory except for withdrawal', async () => {
		const old = (await createMemory(shared('v1'), alice, context)).memory;
		await createMemory(shared('v2', { supersedes: [old.id] }), bob, context);
		await rejection(
			reviseMemory(old.id, { content: 'edit', expectedRevision: 2 }, alice, context),
			409,
			'memory_superseded',
		);
		await rejection(
			setMemoryScopes(old.id, { visibility: 'private', expectedRevision: 2 }, alice, context),
			409,
			'memory_superseded',
		);
		assert.equal((await withdrawMemory(old.id, { expectedRevision: 2 }, alice, context)).status, 'withdrawn');
	});

	it('keeps the superseder covering what it superseded', async () => {
		const old = (await createMemory(shared('v1'), alice, context)).memory;
		const next = (await createMemory(shared('v2', { supersedes: [old.id] }), alice, context)).memory;
		await rejection(
			setMemoryScopes(next.id, { visibility: 'private', expectedRevision: 1 }, alice, context),
			403,
			'supersede_scope_narrowing',
		);
	});

	it('withdrawing the only superseder restores the old memory', async () => {
		const old = (await createMemory(shared('v1'), alice, context)).memory;
		const next = (await createMemory(shared('v2', { supersedes: [old.id] }), bob, context)).memory;
		await withdrawMemory(next.id, { expectedRevision: 1 }, bob, context);
		const restored = await getMemory(old.id, alice);
		assert.equal(restored.status, 'active');
		assert.equal(restored.supersededBy, null);
		assert.equal(restored.revision, 3);
	});

	it('stays superseded while another non-withdrawn memory supersedes it, newest first', async () => {
		const old = (await createMemory(shared('t'), alice, context)).memory;
		const b = (await createMemory(shared('b', { supersedes: [old.id] }), bob, context)).memory;
		const c = (await createMemory(shared('c', { supersedes: [old.id] }), bob, context)).memory;
		assert.equal((await getMemory(old.id, alice)).supersededBy, c.id);
		// c is itself superseded by d: it still carries the chain, so withdrawing b must not restore old.
		await createMemory(shared('d', { supersedes: [c.id] }), bob, context);
		await withdrawMemory(b.id, { expectedRevision: 1 }, bob, context);
		const afterB = await getMemory(old.id, alice);
		assert.equal(afterB.status, 'superseded');
		assert.equal(afterB.supersededBy, c.id);
		await withdrawMemory(c.id, { expectedRevision: 2 }, bob, context);
		assert.equal((await getMemory(old.id, alice)).status, 'active');
	});

	it('recomputes a target whose pointer names a different superseder', async () => {
		const old = (await createMemory(shared('t'), alice, context)).memory;
		const b = (await createMemory(shared('b', { supersedes: [old.id] }), bob, context)).memory;
		const c = (await createMemory(shared('c', { supersedes: [old.id] }), bob, context)).memory;
		await withdrawMemory(c.id, { expectedRevision: 1 }, bob, context);
		assert.equal((await getMemory(old.id, alice)).supersededBy, b.id);
		await withdrawMemory(b.id, { expectedRevision: 1 }, bob, context);
		assert.equal((await getMemory(old.id, alice)).status, 'active');
	});
});

describe('supersede bookkeeping at scale and under contention', () => {
	const shared = (key, overrides = {}) => validInput({ idempotencyKey: key, visibility: 'shared', ...overrides });

	it('takes every lock a withdrawal needs once, in sorted order', async () => {
		const old = (await createMemory(shared('t'), alice, context)).memory;
		const next = (await createMemory(shared('n', { supersedes: [old.id] }), alice, context)).memory;
		__test.lockLog.length = 0;
		await withdrawMemory(next.id, { expectedRevision: 1 }, alice, context);
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[old.id, next.id].sort(),
		);
	});

	it('keeps a target superseded while any of more than 100 superseders remains', async () => {
		const old = (await createMemory(shared('t'), alice, context)).memory;
		const holders = [];
		for (let i = 0; i < 101; i++)
			holders.push((await createMemory(shared(`h${i}`, { supersedes: [old.id] }), bob, context)).memory);
		for (const holder of holders.slice(0, 100)) await withdrawMemory(holder.id, { expectedRevision: 1 }, bob, context);
		const still = await getMemory(old.id, alice);
		assert.equal(still.status, 'superseded');
		assert.equal(still.supersededBy, holders[100].id);
		await withdrawMemory(holders[100].id, { expectedRevision: 1 }, bob, context);
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
			const old = (await createMemory(validInput({ idempotencyKey: 'o', visibility: 'shared' }), alice, context))
				.memory;
			const next = (
				await createMemory(
					validInput({ idempotencyKey: 'n', visibility: 'shared', supersedes: [old.id] }),
					bob,
					context,
				)
			).memory;
			await withdrawMemory(next.id, { expectedRevision: 1 }, bob, context);
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
			const pending = createMemory(validInput(), alice, context);
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
		const old = (await createMemory(validInput({ idempotencyKey: 'o', visibility: 'shared' }), alice, context)).memory;
		const unregister = registerMemorySink({
			write() {
				throw new Error('handoff rejected');
			},
		});
		try {
			await assert.rejects(
				createMemory(validInput({ idempotencyKey: 'n', visibility: 'shared', supersedes: [old.id] }), bob, context),
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
	it('installs the override only for a non-default model, and tags each row with the model that embedded it', async () => {
		await createMemory(validInput(), alice, context);
		assert.equal(__test.setEmbedCalls.length, 0);

		applySettings(parseSettings({ embeddingModel: 'local:small' }));
		const { memory } = await createMemory(validInput({ idempotencyKey: 'k2' }), alice, context);
		assert.deepEqual(__test.setEmbedCalls, [{ table: 'Memory', attribute: 'embedding' }]);
		assert.equal(stored(memory.id).embeddingModel, 'local:small');
		assert.deepEqual(models.calls.at(-1).options, { model: 'local:small', inputType: 'document', signal: undefined });
		assert.ok(databases.memory.Memory.embedders.embedding);
	});
});

describe('typed evidence and evidenceMemoryIds', () => {
	it('accepts all six kinds, derives deduplicated evidenceMemoryIds, and indexes them for search', async () => {
		const m1 = (await createMemory(validInput({ idempotencyKey: 'm1', visibility: 'shared' }), alice, context)).memory;
		const m2 = (await createMemory(validInput({ idempotencyKey: 'm2' }), bob, context)).memory;
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
		const { memory } = await createMemory(validInput({ idempotencyKey: 'citing', evidence }), bob, context);
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

		const revised = await reviseMemory(
			memory.id,
			{ evidence: [{ kind: 'memory', ref: m2.id }], expectedRevision: 1 },
			bob,
			context,
		);
		assert.deepEqual(revised.evidenceMemoryIds, [m2.id]);
		assert.deepEqual(stored(memory.id).evidenceMemoryIds, [m2.id]);
	});

	it('rejects unreadable, missing, or malformed memory-kind refs with the same 400 invalid_evidence on create and revise', async () => {
		const secret = (await createMemory(validInput({ idempotencyKey: 'secret' }), alice, context)).memory;
		const withdrawn = (
			await createMemory(validInput({ idempotencyKey: 'withdrawn', visibility: 'shared' }), alice, context)
		).memory;
		await withdrawMemory(withdrawn.id, { expectedRevision: 1 }, alice, context);
		const missingId = '0'.repeat(32);

		const unreadableErr = await rejection(
			createMemory(
				validInput({ idempotencyKey: 'probe-1', evidence: [{ kind: 'memory', ref: secret.id }] }),
				bob,
				context,
			),
			400,
			'invalid_evidence',
		);
		const missingErr = await rejection(
			createMemory(
				validInput({ idempotencyKey: 'probe-2', evidence: [{ kind: 'memory', ref: missingId }] }),
				bob,
				context,
			),
			400,
			'invalid_evidence',
		);
		const withdrawnErr = await rejection(
			createMemory(
				validInput({ idempotencyKey: 'probe-3', evidence: [{ kind: 'memory', ref: withdrawn.id }] }),
				bob,
				context,
			),
			400,
			'invalid_evidence',
		);
		const malformedErr = await rejection(
			createMemory(
				validInput({ idempotencyKey: 'probe-4', evidence: [{ kind: 'memory', ref: 'not-a-hex-id' }] }),
				bob,
				context,
			),
			400,
			'invalid_evidence',
		);
		assert.equal(unreadableErr.message, missingErr.message);
		assert.equal(withdrawnErr.message, missingErr.message);
		assert.equal(malformedErr.message, missingErr.message);

		const bobs = (await createMemory(validInput({ idempotencyKey: 'bobs' }), bob, context)).memory;
		const reviseUnreadable = await rejection(
			reviseMemory(bobs.id, { evidence: [{ kind: 'memory', ref: secret.id }], expectedRevision: 1 }, bob, context),
			400,
			'invalid_evidence',
		);
		const reviseMissing = await rejection(
			reviseMemory(bobs.id, { evidence: [{ kind: 'memory', ref: missingId }], expectedRevision: 1 }, bob, context),
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
			await rejection(createMemory(validInput({ evidence: bad }), alice, context), 400, 'invalid_evidence');
		}
		await rejection(
			createMemory(
				validInput({ evidence: [{ kind: 'url', ref: 'x'.repeat(EVIDENCE_REF_MAX_CHARS + 1) }] }),
				alice,
				context,
			),
			400,
			'evidence_too_long',
		);
		await rejection(
			createMemory(
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
		const { memory } = await createMemory(validInput({ visibility: 'shared' }), alice, context);
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

	it('returns the same 404 for an unreadable memory as for a missing id on pin and unpin', async () => {
		const secret = (await createMemory(validInput({ idempotencyKey: 'secret' }), alice, context)).memory;
		const missingId = '0'.repeat(32);

		const pinHidden = await rejection(pinMemory(secret.id, {}, bob, context), 404, 'memory_not_found');
		const pinMissing = await rejection(pinMemory(missingId, {}, bob, context), 404, 'memory_not_found');
		assert.equal(pinHidden.message, pinMissing.message);

		const unpinHidden = await rejection(unpinMemory(secret.id, {}, bob, context), 404, 'memory_not_found');
		const unpinMissing = await rejection(unpinMemory(missingId, {}, bob, context), 404, 'memory_not_found');
		assert.equal(unpinHidden.message, unpinMissing.message);
		assert.equal(pinRows().size, 0);
	});

	it('rejects unknown fields in pin and unpin payloads', async () => {
		const { memory } = await createMemory(validInput(), alice, context);
		await rejection(pinMemory(memory.id, { pinned: true }, alice, context), 400, 'unsupported_fields');
		await rejection(unpinMemory(memory.id, { pinned: false }, alice, context), 400, 'unsupported_fields');
	});

	it('caps active pins per principal at 50 and evicts stale pins before rejecting', async () => {
		const memories = [];
		for (let i = 0; i < BOOTSTRAP_PINNED_LIMIT; i++) {
			const { memory } = await createMemory(validInput({ idempotencyKey: `pin-${i}` }), alice, context);
			memories.push(memory);
			await pinMemory(memory.id, {}, alice, context);
		}
		const extra = (await createMemory(validInput({ idempotencyKey: 'pin-extra' }), alice, context)).memory;
		await rejection(pinMemory(extra.id, {}, alice, context), 409, 'pin_limit_exceeded');

		await withdrawMemory(memories[0].id, { expectedRevision: 1 }, alice, context);
		const pinnedExtra = await pinMemory(extra.id, {}, alice, context);
		assert.equal(pinnedExtra.pinned, true);
		assert.equal(pinRows().has(`alice:${memories[0].id}`), false);
		assert.equal(pinRows().has(`alice:${extra.id}`), true);
	});
});
