import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import { importMemories } from '../dist/import.js';
import { confirmMemory, getMemory, pinMemory, putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { bootstrapMemories, searchMemories } from '../dist/search.js';
import { forReader } from '../dist/provenance.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { registerMemorySink } from '../dist/sinks.js';

const grant = (id, read, write) => createPrincipal({ id, grants: { read, write } });
const alice = grant('alice', ['global'], ['global']);
const bob = grant('bob', ['global'], ['global']);
const carol = grant('carol', ['customer:x'], ['customer:x']);
const dave = grant('dave', ['global', 'customer:*'], ['global']);
const erin = grant('erin', ['global', 'customer:x'], ['global']);
const root = createPrincipal({ id: 'root', superUser: true });
const context = { user: { username: 'request-user' } };
const ifMatch = (revision) => ({ ...context, headers: { 'if-match': `"${revision}"` } });
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const stored = (id) => __test.stores.get('Memory').get(id);

const memoryInput = (content, overrides = {}) => ({
	title: content.slice(0, 40),
	content,
	visibility: 'shared',
	...overrides,
});
const citing = (content, ...sourceIds) =>
	memoryInput(content, { evidence: sourceIds.map((ref) => ({ kind: 'memory', ref })) });
const create = async (tag, input, principal = alice) => (await putMemory(idFor(tag), input, principal, context)).memory;

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

describe('flagging on supersede and withdraw', () => {
	it('flags each active citer of a superseded memory in the same write, one hop only', async () => {
		const source = await create('source', memoryInput('kernel tuning guidance for disks'));
		const d1 = await create('d1', citing('first conclusion from kernel guidance', source.id), bob);
		const d2 = await create('d2', citing('second conclusion from kernel guidance', source.id), bob);
		const e = await create('e', citing('conclusion built on the first conclusion', d1.id), bob);
		const ownCiter = await create('own-citer', citing('note on kernel guidance', source.id), alice);

		const { memory: next } = await putMemory(
			idFor('next'),
			{ ...citing('kernel tuning guidance, corrected', source.id), supersedes: [source.id] },
			alice,
			context,
		);
		for (const dependent of [d1, d2]) {
			const flagged = stored(dependent.id);
			assert.deepEqual(flagged.needsReview, {
				since: flagged.needsReview.since,
				cause: 'superseded',
				sourceId: source.id,
				replacementId: next.id,
			});
			assert.ok(flagged.needsReviewSince instanceof Date);
			assert.equal(flagged.needsReviewSince.toISOString(), flagged.needsReview.since);
			assert.equal(flagged.revision, 2);
		}
		assert.equal(stored(e.id).needsReview, null, 'a flagged memory does not flag its own citers');
		assert.equal(stored(next.id).needsReview, null, 'the superseder relied on nothing it replaced');
		assert.equal(stored(ownCiter.id).needsReview.cause, 'superseded', "the superseding author's other citers too");
	});

	it('flags active citers of a withdrawn memory, but not inactive citers or its own superseders', async () => {
		const source = await create('source', memoryInput('retention policy is ninety days'));
		const active = await create('active', citing('backups expire after ninety days', source.id), bob);
		const inactive = await create('inactive', citing('old backup note', source.id), bob);
		await withdrawMemory(inactive.id, {}, bob, ifMatch(1));
		await withdrawMemory(source.id, {}, alice, ifMatch(1));
		assert.deepEqual(stored(active.id).needsReview, {
			since: stored(active.id).needsReview.since,
			cause: 'withdrawn',
			sourceId: source.id,
		});
		assert.equal(stored(inactive.id).needsReview, null);

		const later = await create('later', memoryInput('cache eviction is lru'));
		await create('later-repl', { ...memoryInput('cache eviction is lfu'), supersedes: [later.id] });
		const laterCiter = await create('later-citer', citing('tune for lru eviction', later.id), bob);
		await withdrawMemory(later.id, {}, alice, ifMatch(2));
		assert.equal(
			stored(laterCiter.id).needsReview.replacementId,
			idFor('later-repl'),
			'its replacement at that moment',
		);

		const older = await create('older', memoryInput('cache size is one gigabyte'));
		const superseder = await create('superseder', {
			...citing('cache size is two gigabytes', older.id),
			supersedes: [older.id],
		});
		await withdrawMemory(older.id, {}, alice, ifMatch(2));
		assert.equal(stored(superseder.id).needsReview, null);
	});

	it('flags only on a transition: re-superseding a superseded memory and restoring one flag nothing', async () => {
		const source = await create('source', memoryInput('use region east for staging'));
		const dependent = await create('dependent', citing('staging runs in east', source.id), bob);
		const first = await create('first', { ...memoryInput('use region west for staging'), supersedes: [source.id] });
		await confirmMemory(dependent.id, {}, bob, context);
		assert.equal(stored(dependent.id).needsReview, null);

		await create('second', { ...memoryInput('use region north for staging'), supersedes: [source.id] });
		assert.equal(stored(dependent.id).needsReview, null, 'already superseded: not a transition');
		await withdrawMemory(first.id, {}, alice, ifMatch(1));
		assert.equal(stored(dependent.id).needsReview, null);
	});

	it('keeps the first cause until the owner reviews, without rewriting the row', async () => {
		const a = await create('a', memoryInput('alpha fact about queues'));
		const z = await create('z', memoryInput('zeta fact about queues'));
		const dependent = await create('dependent', citing('queue conclusion', a.id, z.id), bob);
		await create('a2', { ...memoryInput('alpha fact about queues, corrected'), supersedes: [a.id] });
		const flag = stored(dependent.id).needsReview;
		await withdrawMemory(z.id, {}, alice, ifMatch(1));
		assert.deepEqual(stored(dependent.id).needsReview, flag);
		assert.equal(stored(dependent.id).revision, 2);
	});

	it('hands a memory both restored and flagged by one withdrawal to sinks once', async () => {
		const restoredId = idFor('restored');
		const withdrawnId = idFor('withdrawn');
		await importMemories(
			{
				rows: [
					{
						id: withdrawnId,
						ownerId: 'alice',
						content: 'replacement note',
						scopes: ['global'],
						supersedes: [restoredId],
					},
					{
						id: restoredId,
						ownerId: 'bob',
						content: 'original note',
						scopes: ['global'],
						evidence: [{ kind: 'memory', ref: withdrawnId }],
					},
				],
			},
			root,
			context,
		);
		assert.equal(stored(restoredId).status, 'superseded');
		const calls = [];
		const unregister = registerMemorySink({ write: (memory) => calls.push(memory.id), withdraw: () => {} });
		try {
			await withdrawMemory(withdrawnId, {}, alice, ifMatch(1));
		} finally {
			unregister();
		}
		assert.deepEqual(calls, [restoredId]);
		assert.equal(stored(restoredId).status, 'active');
		assert.equal(stored(restoredId).needsReview.cause, 'withdrawn');
	});

	it('runs flagged rows through sinks inside the transaction, and a failing sink rolls the whole write back', async () => {
		const source = await create('source', memoryInput('throttle at one thousand requests'));
		const dependent = await create('dependent', citing('client retries above one thousand', source.id), bob);
		const calls = [];
		let unregister = registerMemorySink({
			write: (memory, txn) => calls.push([memory.id, memory.needsReview?.cause ?? null, Boolean(txn.transaction)]),
			withdraw: (memory) => calls.push([memory.id, 'withdraw']),
		});
		try {
			await withdrawMemory(source.id, {}, alice, ifMatch(1));
		} finally {
			unregister();
		}
		assert.deepEqual(calls, [
			[source.id, 'withdraw'],
			[dependent.id, 'withdrawn', true],
		]);

		const other = await create('other', memoryInput('throttle at two thousand requests'));
		const otherDependent = await create('other-dep', citing('client retries above two thousand', other.id), bob);
		unregister = registerMemorySink({
			write(memory) {
				if (memory.id === otherDependent.id) throw new Error('handoff rejected');
			},
		});
		try {
			await assert.rejects(
				putMemory(
					idFor('repl'),
					{ ...memoryInput('throttle at three thousand'), supersedes: [other.id] },
					alice,
					context,
				),
				/handoff rejected/,
			);
		} finally {
			unregister();
		}
		assert.equal(stored(other.id).status, 'active');
		assert.equal(stored(otherDependent.id).needsReview, null);
		assert.equal(stored(otherDependent.id).needsReviewSince, null);
		assert.equal(stored(otherDependent.id).revision, 1);
		assert.equal(stored(idFor('repl')), undefined);
	});
});

describe('clearing a flag', () => {
	async function flagged() {
		const source = await create('source', memoryInput('deploys freeze on fridays'));
		const dependent = await create('dependent', citing('no friday releases', source.id), bob);
		await create('next', { ...memoryInput('deploys freeze on thursdays'), supersedes: [source.id] });
		assert.ok(stored(dependent.id).needsReview);
		return { source, dependent };
	}

	it('a revise clears it, and revising a source flags none of its citers', async () => {
		const { dependent } = await flagged();
		const revised = await putMemory(dependent.id, { content: 'no thursday releases' }, bob, ifMatch(2));
		assert.equal(revised.memory.needsReview, null);
		assert.equal(stored(dependent.id).needsReviewSince, null);

		const citer = await create('citer', citing('release calendar', dependent.id), alice);
		await putMemory(dependent.id, { content: 'no releases thursday or friday' }, bob, ifMatch(3));
		await confirmMemory(dependent.id, {}, bob, context);
		assert.equal(stored(citer.id).needsReview, null);
	});

	it('confirm clears it, records { by, at }, bumps the revision and honours If-Match', async () => {
		const { dependent } = await flagged();
		await rejection(confirmMemory(dependent.id, {}, bob, ifMatch(1)), 412, 'precondition_failed');
		const confirmed = await confirmMemory(dependent.id, {}, bob, ifMatch(2));
		assert.equal(confirmed.needsReview, null);
		assert.equal(confirmed.confirmed.by, 'bob');
		assert.ok(!Number.isNaN(Date.parse(confirmed.confirmed.at)));
		assert.equal(confirmed.revision, 3);
		assert.equal(stored(dependent.id).needsReviewSince, null);
		assert.equal((await confirmMemory(dependent.id, {}, root, context)).confirmed.by, 'root');
	});

	it('confirm is owner-only: 403 for a reader, the same 404 as a missing id for a non-reader', async () => {
		const { dependent } = await flagged();
		await rejection(confirmMemory(dependent.id, {}, alice, context), 403, 'not_memory_owner');
		const hidden = await rejection(confirmMemory(dependent.id, {}, carol, context), 404, 'memory_not_found');
		const missing = await rejection(confirmMemory('0'.repeat(32), {}, carol, context), 404, 'memory_not_found');
		assert.equal(hidden.message, missing.message);
		await rejection(confirmMemory(dependent.id, { by: 'bob' }, bob, context), 400, 'unsupported_fields');
		assert.equal(stored(dependent.id).revision, 2);
	});

	it('confirm refuses superseded and withdrawn memories', async () => {
		const { source } = await flagged();
		await rejection(confirmMemory(source.id, {}, alice, context), 409, 'memory_superseded');
		const gone = await create('gone', memoryInput('temporary note'));
		await withdrawMemory(gone.id, {}, alice, ifMatch(1));
		await rejection(confirmMemory(gone.id, {}, alice, context), 409, 'memory_withdrawn');
	});
});

describe('who sees a flag', () => {
	// The source is customer-scoped; the citer is global, so some of its readers cannot read the source.
	async function scenario() {
		const source = await create('source', memoryInput('acme runs version four', { scopes: ['customer:x'] }), carol);
		const dependent = await create('dependent', citing('upgrade path for acme', source.id), dave);
		const replacement = await create(
			'replacement',
			{ ...memoryInput('acme runs version five', { scopes: ['customer:x'] }), supersedes: [source.id] },
			carol,
		);
		return { source, dependent, replacement };
	}

	it('shows it to readers of the source and the replacement, and hides it from everyone else', async () => {
		const { source, dependent, replacement } = await scenario();
		const full = {
			since: stored(dependent.id).needsReview.since,
			cause: 'superseded',
			sourceId: source.id,
			replacementId: replacement.id,
		};
		assert.deepEqual((await getMemory(dependent.id, dave)).needsReview, full);
		assert.deepEqual((await getMemory(dependent.id, erin)).needsReview, full);
		assert.deepEqual((await getMemory(dependent.id, root)).needsReview, full);
		assert.equal((await getMemory(dependent.id, alice)).needsReview, null);

		const hits = await searchMemories(
			{ q: 'upgrade', tags: [], scopes: [], limit: 10, includeSuperseded: false, includeExpired: false },
			alice,
			context,
		);
		assert.equal(hits.find((hit) => hit.id === dependent.id).needsReview, null);
		assert.equal((await pinMemory(dependent.id, {}, alice, context)).memory.needsReview, null);

		await withdrawMemory(replacement.id, {}, carol, ifMatch(1));
		assert.equal(stored(source.id).status, 'active', 'restored');
		const { replacementId: _withdrawn, ...withoutReplacement } = full;
		assert.deepEqual((await getMemory(dependent.id, erin)).needsReview, withoutReplacement);
	});

	it('gives concurrent readers sharing one lookup cache the same answer while the lookup is in flight', async () => {
		const { dependent } = await scenario();
		const view = await getMemory(dependent.id, root);
		const Memory = databases.memory.Memory;
		const search = Memory.search.bind(Memory);
		Memory.search = (query, ctx) => {
			const results = search(query, ctx);
			if (query.select?.join() !== 'id,ownerId,scopes,status,contentFlag') return results;
			return (async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10));
				yield* results;
			})();
		};
		const access = new Map();
		let views;
		try {
			views = await Promise.all([forReader([view], erin, context, access), forReader([view], erin, context, access)]);
		} finally {
			Memory.search = search;
		}
		assert.ok(views[0][0].needsReview);
		assert.deepEqual(views[1][0].needsReview, views[0][0].needsReview);
	});

	it('fails a read cleanly when the lookup fails, leaving no unhandled rejection', async () => {
		const { dependent } = await scenario();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const Memory = databases.memory.Memory;
		const search = Memory.search.bind(Memory);
		Memory.search = (query, ctx) => {
			if (query.select?.join() !== 'id,ownerId,scopes,status,contentFlag') return search(query, ctx);
			return (async function* () {
				throw Object.assign(new Error('index rebuilding'), { statusCode: 503 });
			})();
		};
		try {
			await assert.rejects(getMemory(dependent.id, erin, context), /index rebuilding/);
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			Memory.search = search;
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepEqual(unhandled, []);
	});

	it('shows a withdrawal to the source label readers even though the tombstone itself is hidden', async () => {
		const source = await create(
			'source',
			memoryInput('acme contract renews in june', { scopes: ['customer:x'] }),
			carol,
		);
		const dependent = await create('dependent', citing('renewal prep for acme', source.id), dave);
		await withdrawMemory(source.id, {}, carol, ifMatch(1));
		assert.equal(await getMemory(source.id, erin), undefined);
		assert.equal((await getMemory(dependent.id, erin)).needsReview.cause, 'withdrawn');
		assert.equal((await getMemory(dependent.id, alice)).needsReview, null);
	});
});

describe('bootstrap', () => {
	it('lists the caller own flagged memories after pins and before recent ones', async () => {
		const source = await create('source', memoryInput('pager rotation is weekly'));
		const pinned = await create('pinned', memoryInput('on-call handbook'), bob);
		const flagged = await create('flagged', citing('weekly pager handoff', source.id), bob);
		const othersFlagged = await create('others', citing('alice view of the pager', source.id), alice);
		const recent = await create('recent', memoryInput('bob recent note'), bob);
		await pinMemory(pinned.id, {}, bob, context);
		await create('next', { ...memoryInput('pager rotation is daily'), supersedes: [source.id] });
		assert.ok(stored(othersFlagged.id).needsReview);

		const { memories } = await bootstrapMemories({ budget: 8000 }, bob, context);
		assert.deepEqual(
			memories.map((memory) => [memory.id, memory.section]),
			[
				[pinned.id, 'pinned'],
				[flagged.id, 'needsReview'],
				[recent.id, 'recent'],
			],
		);
		assert.equal(memories[1].needsReview.sourceId, source.id);
	});

	it('fills the section with flags the caller can see, past newer ones it cannot', async () => {
		const visibleSource = await create('visible-src', memoryInput('ledger closes monthly'));
		const visible = await create('visible', citing('reconcile at month end', visibleSource.id), dave);
		await create('visible-repl', { ...memoryInput('ledger closes weekly'), supersedes: [visibleSource.id] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		for (let i = 0; i < 20; i++) {
			const source = await create(
				`hidden-src-${i}`,
				memoryInput(`acme ledger rule ${i}`, { scopes: ['customer:x'] }),
				carol,
			);
			await create(`hidden-${i}`, citing(`acme reconciliation ${i}`, source.id), dave);
			await create(
				`hidden-repl-${i}`,
				{ ...memoryInput(`acme ledger rule ${i}, revised`, { scopes: ['customer:x'] }), supersedes: [source.id] },
				carol,
			);
		}
		const revoked = grant('dave', ['global'], ['global']);
		__test.searchLog.length = 0;
		const { memories } = await bootstrapMemories({ budget: 100_000 }, revoked, context);
		const section = memories.filter((memory) => memory.section === 'needsReview').map((memory) => memory.id);
		assert.deepEqual(section, [visible.id]);
		const lookups = __test.searchLog.filter(
			(entry) => entry.query.select?.join() === 'id,ownerId,scopes,status,contentFlag',
		);
		const scan = __test.searchLog.find((entry) =>
			entry.query.conditions?.some((condition) => condition.attribute === 'needsReviewSince'),
		);
		assert.equal(scan.query.limit, 100, 'hidden flags cannot make bootstrap scan without bound');
		assert.ok(lookups.length <= 3, `${lookups.length} access lookups for 21 flags`);
	});
});

describe('lock planning', () => {
	it('locks cited memories with the write, and a transition locks its dependents in the same sorted pass', async () => {
		const source = await create('source', memoryInput('vacuum runs nightly'));
		__test.lockLog.length = 0;
		const dependent = await create('dependent', citing('nightly maintenance window', source.id), bob);
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[dependent.id, source.id].sort(),
		);
		__test.lockLog.length = 0;
		await withdrawMemory(source.id, {}, alice, ifMatch(1));
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[dependent.id, source.id].sort(),
		);
	});

	it('a revise locks only the citations it adds', async () => {
		const kept = await create('kept', memoryInput('vacuum runs nightly'));
		const added = await create('added', memoryInput('analyze runs weekly'));
		const citer = await create('citer', citing('maintenance window', kept.id), bob);
		__test.lockLog.length = 0;
		await putMemory(
			citer.id,
			{ ...citing('maintenance window', kept.id), title: 'maintenance window' },
			bob,
			ifMatch(1),
		);
		await putMemory(citer.id, citing('maintenance window', kept.id, added.id), bob, ifMatch(1));
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[citer.id, ...[added.id, citer.id].sort()],
		);
	});

	it('a refused withdrawal never plans the dependent fan-out', async () => {
		const source = await create('source', memoryInput('vacuum runs nightly'));
		await create('dependent', citing('nightly maintenance window', source.id), bob);
		__test.lockLog.length = 0;
		await rejection(withdrawMemory(source.id, {}, bob, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(withdrawMemory(source.id, {}, alice, context), 428, 'if_match_required');
		await rejection(withdrawMemory(source.id, {}, alice, ifMatch(9)), 412, 'precondition_failed');
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[source.id, source.id, source.id],
		);
	});

	it('locks the unplanned citers of every superseded memory in one restart', async () => {
		const targets = [];
		for (const n of [1, 2, 3]) {
			const target = await create(`target-${n}`, memoryInput(`replica lag budget ${n}`));
			await create(`citer-${n}`, citing(`alert on replica lag ${n}`, target.id), bob);
			targets.push(target.id);
		}
		const Memory = databases.memory.Memory;
		const original = Memory.search.bind(Memory);
		Memory.search = (query, ctx) => {
			const citers = query.conditions?.some((condition) => condition.attribute === 'evidenceMemoryIds');
			return citers && !ctx?.transaction ? (async function* () {})() : original(query, ctx);
		};
		__test.lockLog.length = 0;
		try {
			await putMemory(
				idFor('all'),
				{ ...memoryInput('replica lag budget, unified'), supersedes: targets },
				alice,
				context,
			);
		} finally {
			Memory.search = original;
		}
		const attempts = __test.lockLog.filter((entry) => entry.id === idFor('all')).length;
		assert.equal(attempts, 2);
		for (const n of [1, 2, 3]) assert.equal(stored(idFor(`citer-${n}`)).needsReview.cause, 'superseded');
	});

	it('retries with a dependent that appeared after planning, and gives up with 503 before any sink runs', async () => {
		const source = await create('source', memoryInput('vacuum runs nightly'));
		const dependent = await create('dependent', citing('nightly maintenance window', source.id), bob);
		const Memory = databases.memory.Memory;
		const original = Memory.search.bind(Memory);
		const citersOf = (query) => query.conditions?.find((condition) => condition.attribute === 'evidenceMemoryIds');
		Memory.search = (query, ctx) => {
			if (citersOf(query) && !ctx?.transaction) return (async function* () {})();
			return original(query, ctx);
		};
		__test.lockLog.length = 0;
		try {
			await withdrawMemory(source.id, {}, alice, ifMatch(1));
		} finally {
			Memory.search = original;
		}
		assert.deepEqual(
			__test.lockLog.map((entry) => entry.id),
			[source.id, ...[dependent.id, source.id].sort()],
		);
		assert.equal(stored(dependent.id).needsReview.cause, 'withdrawn');

		const other = await create('other', memoryInput('analyze runs weekly'));
		let ghost = 0;
		Memory.search = (query, ctx) => {
			if (citersOf(query) && ctx?.transaction) {
				return (async function* () {
					yield { id: `ghost-dependent-${++ghost}`.padEnd(16, '_') };
				})();
			}
			return original(query, ctx);
		};
		const calls = [];
		const unregister = registerMemorySink({
			write: (memory) => calls.push(memory.id),
			withdraw: (memory) => calls.push(memory.id),
		});
		try {
			await rejection(withdrawMemory(other.id, {}, alice, ifMatch(1)), 503, 'unavailable');
		} finally {
			Memory.search = original;
			unregister();
		}
		assert.equal(ghost, 3);
		assert.deepEqual(calls, []);
		assert.equal(stored(other.id).status, 'active');
	});
});

describe('import', () => {
	const row = (id, content, overrides = {}) => ({
		id,
		ownerId: 'alice',
		content,
		scopes: ['global'],
		status: 'active',
		...overrides,
	});

	it('never flags a citer the same batch supersedes', async () => {
		const source = await create('source', memoryInput('compaction runs hourly'));
		const citer = await create('citer', citing('schedule backups between compactions', source.id), bob);
		await importMemories(
			{
				rows: [
					row(idFor('repl-source'), 'compaction runs every two hours', { supersedes: [source.id] }),
					row(idFor('repl-citer'), 'backups run at midnight', { supersedes: [citer.id] }),
				],
			},
			root,
			context,
		);
		assert.equal(stored(citer.id).status, 'superseded');
		assert.equal(stored(citer.id).needsReview, null);
		assert.equal(stored(citer.id).needsReviewSince, null);
		assert.equal(stored(citer.id).revision, 2);
	});

	for (const order of ['citer first', 'superseder first']) {
		it(`flags stored and batch-created citers of a stored row the batch supersedes (${order}), never its superseders`, async () => {
			const source = await create('source', memoryInput('index rebuilds take an hour'));
			const storedCiter = await create('stored-citer', citing('plan an hour for rebuilds', source.id), bob);
			const batchCiter = row(idFor('batch-citer'), 'rebuild runbook', {
				evidence: [{ kind: 'memory', ref: source.id }],
			});
			const superseder = row(idFor('batch-repl'), 'index rebuilds take ten minutes', {
				supersedes: [source.id],
				evidence: [{ kind: 'memory', ref: source.id }],
			});
			const rows = order === 'citer first' ? [batchCiter, superseder] : [superseder, batchCiter];
			await importMemories({ rows }, root, context);
			assert.equal(stored(source.id).status, 'superseded');
			for (const id of [storedCiter.id, batchCiter.id]) {
				assert.deepEqual(
					{ ...stored(id).needsReview, since: undefined },
					{ since: undefined, cause: 'superseded', sourceId: source.id, replacementId: superseder.id },
					id,
				);
			}
			assert.equal(stored(superseder.id).needsReview, null);
		});
	}
});
