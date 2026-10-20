import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import { importMemories } from '../dist/import.js';
import { getMemory, linkSupersedes, putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { registerMemorySink } from '../dist/sinks.js';
import { memoryCandidates } from '../dist/supersession.js';

const grant = (id, read, write) => createPrincipal({ id, grants: { read, write } });
const alice = grant('alice', ['global'], ['global']);
const bob = grant('bob', ['global', 'team:y'], ['global', 'team:y']);
const carol = grant('carol', ['customer:x'], ['customer:x']);
const root = createPrincipal({ id: 'root', superUser: true });
const context = { user: { username: 'request-user' } };
const ifMatch = (revision) => ({ ...context, headers: { 'if-match': `"${revision}"` } });
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const stored = (id) => __test.stores.get('Memory').get(id);

const GREBE = 'grebe colony counted at forty pairs on the north lake';
const shared = (content = GREBE, overrides = {}) => ({
	title: content.slice(0, 30),
	content,
	visibility: 'shared',
	...overrides,
});
// Each create a millisecond apart, so creation order is createdAt order.
const create = async (tag, input = shared(), principal = alice) => {
	await new Promise((resolve) => setTimeout(resolve, 2));
	return (await putMemory(idFor(tag), input, principal, context)).memory;
};
const link = (replacement, ids, principal = alice, revision = stored(replacement).revision, extra = {}) =>
	linkSupersedes(replacement, { ids, ...extra }, principal, ifMatch(revision));
const ids = (candidates) => candidates.map((candidate) => candidate.id);

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

const importRows = (rows) =>
	importMemories(
		{ rows: rows.map((row) => ({ ownerId: 'alice', scopes: ['global'], status: 'active', ...row })) },
		root,
		context,
	);

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('memoryCandidates', () => {
	it('proposes only older, active, unexpired memories that share a label and pass the threshold', async () => {
		const older = await create('older', shared(`${GREBE} in spring`));
		const narrow = await create('narrow', shared(`${GREBE} in summer`, { scopes: ['team:y'] }), bob);
		const unrelated = await create('unrelated', shared('kernel tuning guidance for disks'));
		const expired = await create('expired', shared(`${GREBE} in winter`, { validUntil: '2020-01-01T00:00:00Z' }));
		const retired = await create('retired', shared(`${GREBE} in autumn`));
		await withdrawMemory(retired.id, {}, alice, ifMatch(1));
		const source = await create('source', shared(`${GREBE} this year`));
		const newer = await create('newer', shared(`${GREBE} next year`));

		const candidates = await memoryCandidates(source.id, alice, context);
		assert.deepEqual(ids(candidates), [older.id]);
		assert.deepEqual(Object.keys(candidates[0]).sort(), ['id', 'similarity', 'title']);
		assert.ok(candidates[0].similarity >= 0.82);
		for (const excluded of [narrow, unrelated, expired, retired, newer, source]) {
			assert.ok(!ids(candidates).includes(excluded.id), excluded.id);
		}
		assert.deepEqual(ids(await memoryCandidates(newer.id, alice, context)).sort(), [older.id, source.id].sort());
	});

	it('proposes only what the caller can read, and leaves out what the memory already supersedes', async () => {
		await importRows([
			{
				id: idFor('secret'),
				content: GREBE,
				scopes: ['customer:x'],
				ownerId: 'carol',
				createdAt: '2025-01-01T00:00:00Z',
			},
		]);
		const old = await create('old', shared(`${GREBE} in spring`));
		const replaced = await create('replaced', shared(`${GREBE} in summer`));
		// Owned by alice, who reads only one of its labels.
		await importRows([
			{ id: idFor('source'), content: `${GREBE} today`, scopes: ['customer:x', 'global'], supersedes: [replaced.id] },
		]);
		assert.deepEqual(ids(await memoryCandidates(idFor('source'), alice, context)), [old.id]);
		assert.deepEqual(
			ids(await memoryCandidates(idFor('source'), root, context)).sort(),
			[old.id, idFor('secret')].sort(),
		);
	});

	it('orders same-millisecond memories by id, inside the query, so newer peers cannot crowd out older rows', async () => {
		const at = '2025-06-01T00:00:00.000Z';
		const peer = (n) => `peer-${String(n).padStart(2, '0')}`.padEnd(16, '_');
		await importRows([
			{ id: 'aaaa-oldest-row__', content: `${GREBE} oldest`, createdAt: '2025-01-01T00:00:00.000Z' },
			...[...Array(10).keys()].map((n) => ({ id: peer(n), content: `${GREBE} peer ${n}`, createdAt: at })),
		]);
		assert.deepEqual(ids(await memoryCandidates(peer(0), root, context)), ['aaaa-oldest-row__']);
		const fromLast = ids(await memoryCandidates(peer(9), root, context));
		assert.equal(fromLast.length, 5);
		assert.ok(fromLast.every((id) => id < peer(9)));
	});

	it('runs whatever supersession.mode says, since mode governs writes only', async () => {
		applySettings(parseSettings({ supersession: { mode: 'off' } }));
		const old = await create('old', shared(`${GREBE} in spring`));
		const source = await create('source');
		assert.deepEqual(ids(await memoryCandidates(source.id, alice, context)), [old.id]);
	});

	it('is owner or super_user only, with the missing-id 404 for a non-reader, and 409 for a withdrawn memory', async () => {
		const source = await create('source');
		await rejection(memoryCandidates(source.id, bob, context), 403, 'not_memory_owner');
		const missing = await rejection(memoryCandidates(idFor('missing'), carol, context), 404, 'memory_not_found');
		const unreadable = await rejection(memoryCandidates(source.id, carol, context), 404, 'memory_not_found');
		assert.equal(unreadable.message, missing.message);
		await rejection(memoryCandidates('short', alice, context), 404, 'memory_not_found');
		await withdrawMemory(source.id, {}, alice, ifMatch(1));
		await rejection(memoryCandidates(source.id, alice, context), 409, 'memory_withdrawn');
	});

	it('fails rather than answering "none" when the search fails', async () => {
		const source = await create('source');
		const Memory = databases.memory.Memory;
		const original = Memory.search;
		Memory.search = () => {
			throw new Error('index closed');
		};
		try {
			await assert.rejects(memoryCandidates(source.id, alice, context), /index closed/);
		} finally {
			Memory.search = original;
		}
	});
});

describe('linkSupersedes', () => {
	// The same history built twice: the replacement supersedes at create, or is linked after the fact.
	async function scenario(linked) {
		__test.reset();
		const sinkWrites = [];
		const unregister = registerMemorySink({ write: (memory) => sinkWrites.push(memory.id), withdraw: () => {} });
		try {
			const source = await create('source', shared('kernel tuning guidance for disks'));
			const citer = await create(
				'citer',
				shared('conclusion from kernel guidance', { evidence: [{ kind: 'memory', ref: source.id }] }),
				bob,
			);
			const input = shared('kernel tuning guidance, corrected', { evidence: [{ kind: 'memory', ref: source.id }] });
			sinkWrites.length = 0;
			if (linked) {
				await create('replacement', input);
				sinkWrites.length = 0;
				await link(idFor('replacement'), [source.id]);
			} else {
				await create('replacement', { ...input, supersedes: [source.id] });
			}
			const pick = (id) => {
				const { status, supersededBy, revision, lastEventKind, needsReview } = stored(id);
				return {
					status,
					supersededBy,
					revision,
					lastEventKind,
					needsReview: needsReview && { ...needsReview, since: 'T' },
				};
			};
			return { source: pick(source.id), citer: pick(citer.id), replacement: pick(idFor('replacement')), sinkWrites };
		} finally {
			unregister();
		}
	}

	it('supersedes and flags exactly as create-time supersede does', async () => {
		const created = await scenario(false);
		const linked = await scenario(true);
		assert.deepEqual(linked.source, created.source);
		assert.deepEqual(linked.source, {
			status: 'superseded',
			supersededBy: idFor('replacement'),
			revision: 2,
			lastEventKind: 'superseded',
			needsReview: null,
		});
		assert.deepEqual(linked.citer, created.citer);
		assert.deepEqual(linked.citer.needsReview, {
			since: 'T',
			cause: 'superseded',
			sourceId: idFor('source'),
			replacementId: idFor('replacement'),
		});
		assert.equal(linked.replacement.needsReview, null, 'a replacement that cites its target is not flagged for it');
		assert.deepEqual(
			{ ...linked.replacement, revision: undefined, lastEventKind: undefined },
			{ ...created.replacement, revision: undefined, lastEventKind: undefined },
		);
		assert.deepEqual(linked.replacement, { ...created.replacement, revision: 2, lastEventKind: 'revised' });
		assert.deepEqual(linked.sinkWrites, created.sinkWrites);
		assert.deepEqual(stored(idFor('replacement')).supersedes, [idFor('source')]);
		assert.deepEqual(stored(idFor('replacement')).autoSupersedes, []);
	});

	it('is owner or super_user only, with the missing-id 404 for a non-reader of the replacement', async () => {
		const target = await create('target', shared(`${GREBE} in spring`));
		const replacement = await create('replacement');
		await rejection(link(replacement.id, [target.id], bob), 403, 'not_memory_owner');
		const missing = await rejection(link(idFor('missing'), [target.id], carol, 1), 404, 'memory_not_found');
		const unreadable = await rejection(link(replacement.id, [target.id], carol), 404, 'memory_not_found');
		assert.equal(unreadable.message, missing.message);
		const { supersedes, revision } = await link(replacement.id, [target.id], root);
		assert.deepEqual(supersedes, [target.id]);
		assert.equal(revision, 2);
	});

	it('refuses an unreadable target with the missing-id 404, a narrowing replacement, and a withdrawn target', async () => {
		const secret = await create('secret', shared(GREBE, { scopes: ['customer:x'] }), carol);
		const replacement = await create('replacement');
		const missing = await rejection(link(replacement.id, [idFor('missing')]), 404, 'memory_not_found');
		const unreadable = await rejection(link(replacement.id, [secret.id]), 404, 'memory_not_found');
		assert.equal(unreadable.message, missing.message);
		const wide = await create('wide', shared(GREBE, { scopes: ['global', 'team:y'] }), bob);
		await rejection(link(replacement.id, [wide.id], root), 403, 'supersede_scope_narrowing');
		const retired = await create('retired', shared(`${GREBE} retired`));
		await withdrawMemory(retired.id, {}, alice, ifMatch(1));
		await rejection(link(replacement.id, [retired.id]), 409, 'memory_withdrawn');
		assert.equal(stored(replacement.id).revision, 1, 'a refused link writes nothing');
	});

	it('requires a current If-Match on the replacement and honours target revisions', async () => {
		const target = await create('target', shared(`${GREBE} in spring`));
		const replacement = await create('replacement');
		await rejection(linkSupersedes(replacement.id, { ids: [target.id] }, alice, context), 428, 'if_match_required');
		await rejection(link(replacement.id, [target.id], alice, 7), 412, 'precondition_failed');
		await rejection(
			link(replacement.id, [target.id], alice, 1, { revisions: { [target.id]: 3 } }),
			412,
			'precondition_failed',
		);
		for (const revisions of [{}, { [target.id]: 0 }, { [target.id]: 1, [idFor('other')]: 1 }, [1]]) {
			await rejection(link(replacement.id, [target.id], alice, 1, { revisions }), 400, 'invalid_revisions');
		}
		await link(replacement.id, [target.id], alice, 1, { revisions: { [target.id]: 1 } });
		assert.equal(stored(target.id).status, 'superseded');
		await withdrawMemory(replacement.id, {}, alice, ifMatch(2));
		await rejection(link(replacement.id, [target.id], alice, 3), 409, 'memory_withdrawn');
	});

	it('requires write on the replacement labels, as a create would', async () => {
		const target = await create('target', shared(`${GREBE} in spring`), bob);
		const replacement = await create('replacement');
		const revoked = grant('alice', ['global'], []);
		await rejection(link(replacement.id, [target.id], revoked), 403, 'scope_not_writable');
		assert.equal(stored(target.id).status, 'active');
	});

	it('refuses a create that would close a cycle through a link an import left pointing at a missing id', async () => {
		await importRows([{ id: idFor('imported'), content: `${GREBE} imported`, supersedes: [idFor('later')] }]);
		await rejection(
			putMemory(idFor('later'), { ...shared(`${GREBE} later`), supersedes: [idFor('imported')] }, alice, context),
			409,
			'supersede_cycle',
		);
		assert.equal(stored(idFor('later')), undefined);
		assert.equal(stored(idFor('imported')).status, 'active');
	});

	it('validates ids', async () => {
		const replacement = await create('replacement');
		for (const input of [{}, { ids: null }, { ids: [] }]) {
			await rejection(linkSupersedes(replacement.id, input, alice, ifMatch(1)), 400, 'invalid_ids');
		}
		await rejection(link(replacement.id, ['bad id']), 400, 'invalid_ids');
		await rejection(link(replacement.id, [replacement.id]), 400, 'self_supersede');
		const many = [...Array(11).keys()].map((n) => idFor(`t${n}`));
		await rejection(link(replacement.id, many), 400, 'ids_too_many');
		await rejection(
			linkSupersedes(replacement.id, { ids: [idFor('x')], extra: 1 }, alice, ifMatch(1)),
			400,
			'unsupported_fields',
		);
	});

	it('is idempotent: linking an already linked memory writes nothing', async () => {
		const target = await create('target', shared(`${GREBE} in spring`));
		const replacement = await create('replacement');
		await link(replacement.id, [target.id]);
		const again = await link(replacement.id, [target.id], alice, 2);
		assert.equal(again.revision, 2);
		assert.equal(stored(target.id).revision, 2);
	});

	it('links a chain newest first: a superseded replacement can still supersede an older memory', async () => {
		const a = await create('a', shared(`${GREBE} version one`));
		const b = await create('b', shared(`${GREBE} version two`));
		const c = await create('c', shared(`${GREBE} version three`));
		const citer = await create(
			'citer',
			shared('note citing version one', { evidence: [{ kind: 'memory', ref: a.id }] }),
			bob,
		);
		await link(c.id, [b.id]);
		await link(b.id, [a.id]);
		assert.equal(stored(a.id).status, 'superseded');
		assert.equal(stored(a.id).supersededBy, b.id);
		assert.equal(stored(citer.id).needsReview.replacementId, b.id);
		assert.equal((await getMemory(a.id, alice, context)).supersededBy, b.id);

		// The newest superseder keeps the pointer, and a non-transition flags nothing.
		const d = await create('d', shared(`${GREBE} version four`));
		await link(d.id, [a.id]);
		assert.equal(stored(a.id).supersededBy, d.id);
		await link(c.id, [a.id], alice, stored(c.id).revision);
		assert.equal(stored(a.id).supersededBy, d.id);
		assert.equal(stored(citer.id).needsReview.replacementId, b.id, 'the first cause stands');
	});

	it('refuses a link that would close a cycle, however long', async () => {
		const a = await create('a', shared(`${GREBE} version one`));
		const b = await create('b', shared(`${GREBE} version two`));
		const c = await create('c', shared(`${GREBE} version three`));
		await link(b.id, [a.id]);
		await rejection(link(a.id, [b.id]), 409, 'supersede_cycle');
		await link(c.id, [b.id]);
		await rejection(link(a.id, [c.id]), 409, 'supersede_cycle');
		// Through a withdrawn memory the old edge no longer counts, so no cycle closes.
		await withdrawMemory(b.id, {}, alice, ifMatch(stored(b.id).revision));
		assert.equal(stored(a.id).status, 'active');
		await link(a.id, [c.id]);
		assert.equal(stored(c.id).supersededBy, a.id);
	});

	it('refuses a link past the stored cap', async () => {
		const rows = [...Array(100).keys()].map((n) => ({
			id: `cap-target-${String(n).padStart(3, '0')}`.padEnd(16, '_'),
			content: `target ${n}`,
		}));
		await importRows(rows);
		await importRows([{ id: idFor('full'), content: GREBE, supersedes: rows.map((row) => row.id) }]);
		const extra = await create('extra', shared(`${GREBE} extra`));
		await rejection(link(idFor('full'), [extra.id], root), 409, 'supersedes_too_many');
	});

	it('locks only the replacement for a refused link, and the plan in one sorted pass for an allowed one', async () => {
		const target = await create('target', shared(`${GREBE} in spring`));
		const citer = await create(
			'citer',
			shared('note citing spring', { evidence: [{ kind: 'memory', ref: target.id }] }),
			bob,
		);
		const wide = await create('wide', shared(GREBE, { scopes: ['global', 'team:y'] }), bob);
		const replacement = await create('replacement');
		__test.lockLog.length = 0;
		await rejection(link(replacement.id, [wide.id], root), 403, 'supersede_scope_narrowing');
		await rejection(link(replacement.id, [target.id], alice, 5), 412, 'precondition_failed');
		await rejection(
			link(replacement.id, [target.id], alice, 1, { revisions: { [target.id]: 9 } }),
			412,
			'precondition_failed',
		);
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[replacement.id, replacement.id, replacement.id],
		);
		__test.lockLog.length = 0;
		await link(replacement.id, [target.id]);
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[citer.id, replacement.id, target.id].sort(),
		);
	});

	it('keeps the create-time invariants afterwards: withdrawal restores, and the replacement cannot narrow', async () => {
		const target = await create('target', shared(`${GREBE} in spring`, { scopes: ['global', 'team:y'] }), bob);
		const replacement = await create('replacement', shared(GREBE, { scopes: ['global', 'team:y'] }), bob);
		await link(replacement.id, [target.id], bob);
		await rejection(
			putMemory(replacement.id, { scopes: ['global'] }, bob, ifMatch(2)),
			403,
			'supersede_scope_narrowing',
		);
		await withdrawMemory(replacement.id, {}, bob, ifMatch(2));
		assert.equal(stored(target.id).status, 'active');
		assert.equal(stored(target.id).supersededBy, null);
	});
});
