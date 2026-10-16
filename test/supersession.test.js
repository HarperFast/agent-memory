import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases, models } from 'harper';
import { getMemory, putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { parseVerdict } from '../dist/supersession.js';

const grant = (id, read, write) => createPrincipal({ id, grants: { read, write } });
const alice = grant('alice', ['global'], ['global']);
const bob = grant('bob', ['global', 'team:y'], ['global', 'team:y']);
const carol = grant('carol', ['customer:x'], ['customer:x']);
// Writes customer:x without reading it: a label it shares is not a licence to read.
const wally = grant('wally', ['global'], ['global', 'customer:x']);
const context = { user: { username: 'request-user' } };
const ifMatch = (revision) => ({ ...context, headers: { 'if-match': `"${revision}"` } });
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const stored = (id) => __test.stores.get('Memory').get(id);

const DISK = 'The database stalls when iowait passes thirty percent on the east cluster';
const shared = (content = DISK, overrides = {}) => ({
	title: 'Disk saturation',
	content,
	visibility: 'shared',
	...overrides,
});
const ids = (candidates) => candidates.map((candidate) => candidate.id);

const configure = (supersession) => applySettings(parseSettings({ supersession }));
// The stub judge answers by a marker in the new memory, which comes first in the prompt.
const judgeByMarker = (input) => {
	const prompt = input.messages[0].content;
	const written = prompt.slice(0, prompt.indexOf('<existing_memory>'));
	if (written.includes('REPLACES')) return 'supersedes';
	if (written.includes('EXTENDS')) return 'refines';
	return 'unrelated';
};

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
	configure(undefined);
});

describe('parseVerdict', () => {
	it('accepts only a complete one-word answer', () => {
		for (const [content, verdict] of [
			['supersedes', 'supersedes'],
			['  Refines.\n', 'refines'],
			['"unrelated"', 'unrelated'],
			['**SUPERSEDES**', 'supersedes'],
		]) {
			assert.equal(parseVerdict({ content, finishReason: 'stop' }), verdict, content);
		}
		for (const result of [
			{ content: 'supersedes is incorrect; unrelated', finishReason: 'stop' },
			{ content: 'supersede', finishReason: 'stop' },
			{ content: '', finishReason: 'stop' },
			{ content: 'supersedes', finishReason: 'length' },
			{ content: 'supersedes', finishReason: 'content_filter' },
			{ content: 'supersedes', finishReason: 'stop', toolCalls: [{ id: 't', name: 'x', arguments: {} }] },
			undefined,
		]) {
			assert.equal(parseVerdict(result), undefined, JSON.stringify(result));
		}
	});
});

describe('write-time candidates (suggest)', () => {
	it('returns the nearest active memories the writer can read that share a scope label, above the threshold', async () => {
		const near = (await putMemory(idFor('near'), shared(), alice, context)).memory;
		const unrelated = (await putMemory(idFor('far'), shared('pelican nesting begins in march'), alice, context)).memory;
		const { candidates, created } = await putMemory(idFor('new'), shared(`${DISK} again`), bob, context);
		assert.equal(created, true);
		assert.deepEqual(ids(candidates), [near.id]);
		assert.equal(candidates[0].title, 'Disk saturation');
		assert.ok(candidates[0].similarity >= 0.82 && candidates[0].similarity <= 1, String(candidates[0].similarity));
		assert.deepEqual(Object.keys(candidates[0]).sort(), ['id', 'similarity', 'title']);
		assert.ok(!ids(candidates).includes(unrelated.id));
		assert.equal(stored(near.id).status, 'active');
	});

	it('excludes memories the writer cannot read, and readable ones sharing no scope label', async () => {
		const hidden = (await putMemory(idFor('hidden'), shared(DISK, { scopes: ['customer:x'] }), carol, context)).memory;
		const otherLabel = (await putMemory(idFor('team'), shared(DISK, { scopes: ['team:y'] }), bob, context)).memory;
		const visible = (await putMemory(idFor('visible'), shared(DISK), alice, context)).memory;

		const fromWally = await putMemory(
			idFor('wally'),
			shared(DISK, { scopes: ['customer:x', 'global'] }),
			wally,
			context,
		);
		assert.deepEqual(ids(fromWally.candidates), [visible.id], 'customer:x is shared but unreadable to wally');

		const fromBob = await putMemory(idFor('bobglobal'), shared(DISK), bob, context);
		assert.ok(!ids(fromBob.candidates).includes(otherLabel.id), 'bob reads team:y, but the new memory is global only');
		assert.ok(!ids(fromBob.candidates).includes(hidden.id));
	});

	it('excludes the memory itself, inactive and expired memories, and what the write explicitly supersedes', async () => {
		const superseded = (await putMemory(idFor('old'), shared(), alice, context)).memory;
		await putMemory(
			idFor('old-repl'),
			shared('pelican nesting begins in march', { supersedes: [superseded.id] }),
			alice,
			context,
		);
		const withdrawn = (await putMemory(idFor('gone'), shared(), alice, context)).memory;
		await withdrawMemory(withdrawn.id, {}, alice, ifMatch(1));
		await putMemory(idFor('expired'), shared(DISK, { validUntil: '2020-01-01T00:00:00.000Z' }), alice, context);
		const target = (await putMemory(idFor('target'), shared(), alice, context)).memory;
		const live = (await putMemory(idFor('live'), shared(), alice, context)).memory;

		const { memory, candidates } = await putMemory(
			idFor('new'),
			shared(DISK, { supersedes: [target.id] }),
			bob,
			context,
		);
		assert.deepEqual(ids(candidates), [live.id]);

		const revised = await putMemory(memory.id, { content: `${DISK} revised` }, bob, ifMatch(1));
		assert.equal(revised.created, false);
		assert.deepEqual(ids(revised.candidates), [live.id], 'a revise reports candidates and never itself');
		const retry = await putMemory(memory.id, { content: `${DISK} revised` }, bob, ifMatch(2));
		assert.equal(retry.revision, 2);
		assert.deepEqual(ids(retry.candidates), [live.id], 'so does an identical retry');
	});

	it('compares only rows embedded by the written row model', async () => {
		await putMemory(idFor('default-model'), shared(), alice, context);
		applySettings(parseSettings({ embeddingModel: 'local:other' }));
		const { candidates } = await putMemory(idFor('other-model'), shared(), alice, context);
		assert.deepEqual(candidates, []);
	});

	it('honours supersession.similarity', async () => {
		await putMemory(idFor('near'), shared(), alice, context);
		configure({ similarity: 1 });
		const { candidates } = await putMemory(idFor('slightly'), shared(`${DISK} again`), alice, context);
		assert.deepEqual(candidates, []);
	});

	it('degrades to no candidates when the index is unavailable, without failing the write', async () => {
		await putMemory(idFor('near'), shared(), alice, context);
		const Memory = databases.memory.Memory;
		const original = Memory.search.bind(Memory);
		Memory.search = (query, ctx) => {
			if (query.sort?.target) throw Object.assign(new Error('index lagging'), { statusCode: 503 });
			return original(query, ctx);
		};
		try {
			const { created, candidates } = await putMemory(idFor('new'), shared(), alice, context);
			assert.equal(created, true);
			assert.deepEqual(candidates, []);
		} finally {
			Memory.search = original;
		}
		assert.equal(stored(idFor('new')).status, 'active');
	});

	it('judges each candidate after commit and acts on none of them', async () => {
		configure({ judge: 'local:judge' });
		const near = (await putMemory(idFor('near'), shared(), alice, context)).memory;
		let committed;
		models.generator = (input, options) => {
			committed = Boolean(stored(idFor('new')));
			assert.equal(options.model, 'local:judge');
			assert.ok(options.maxTokens > 0);
			return judgeByMarker(input);
		};
		const { candidates } = await putMemory(idFor('new'), shared(`${DISK} REPLACES`), bob, context);
		assert.equal(committed, true, 'the judge runs after the write committed');
		assert.deepEqual(candidates, [
			{ id: near.id, title: 'Disk saturation', similarity: candidates[0].similarity, verdict: 'supersedes' },
		]);
		assert.equal(stored(near.id).status, 'active');
	});

	it('leaves a candidate unjudged when the judge fails or does not answer in time', async () => {
		configure({ judge: 'local:judge' });
		await putMemory(idFor('near'), shared(), alice, context);
		models.generator = () => {
			throw new Error('backend down');
		};
		const failed = await putMemory(idFor('failed'), shared(), alice, context);
		assert.equal(failed.created, true);
		assert.equal(failed.candidates[0].verdict, undefined);

		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			models.generator = () => new Promise(() => {});
			const pending = putMemory(idFor('hung'), shared(), alice, context);
			while (models.generateCalls.length < 3) await new Promise((resolve) => setImmediate(resolve));
			mock.timers.tick(20_000);
			const hung = await pending;
			assert.equal(hung.created, true);
			assert.ok(hung.candidates.length > 0);
			assert.ok(hung.candidates.every((candidate) => candidate.verdict === undefined));
		} finally {
			mock.timers.reset();
		}
	});
});

describe('auto mode', () => {
	beforeEach(() => {
		configure({ mode: 'auto', judge: 'local:judge' });
		models.generator = judgeByMarker;
	});

	it('applies a supersedes verdict on create through the explicit supersede path', async () => {
		const old = (await putMemory(idFor('old'), shared(), alice, context)).memory;
		const { memory, candidates } = await putMemory(idFor('new'), shared(`${DISK} REPLACES`), bob, context);
		assert.deepEqual(candidates, [
			{
				id: old.id,
				title: 'Disk saturation',
				similarity: candidates[0].similarity,
				verdict: 'supersedes',
				applied: true,
			},
		]);
		assert.deepEqual(memory.supersedes, [old.id]);
		assert.deepEqual(memory.autoSupersedes, [old.id]);
		const after = await getMemory(old.id, alice);
		assert.equal(after.status, 'superseded');
		assert.equal(after.supersededBy, memory.id);
		assert.equal(after.revision, 2);
	});

	it('reports refines and unrelated verdicts without acting', async () => {
		const old = (await putMemory(idFor('old'), shared(), alice, context)).memory;
		const { candidates } = await putMemory(idFor('new'), shared(`${DISK} EXTENDS`), bob, context);
		assert.deepEqual(
			candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied })),
			[{ id: old.id, verdict: 'refines', applied: undefined }],
		);
		assert.equal(stored(old.id).status, 'active');
	});

	it('reports a supersedes verdict it may not apply: scope narrowing, or a candidate revised after it was judged', async () => {
		const wider = (await putMemory(idFor('wider'), shared(DISK, { scopes: ['global', 'team:y'] }), bob, context))
			.memory;
		const narrowing = await putMemory(idFor('narrow'), shared(`${DISK} REPLACES`), alice, context);
		assert.deepEqual(
			narrowing.candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied })),
			[{ id: wider.id, verdict: 'supersedes', applied: false }],
		);
		assert.equal(stored(wider.id).status, 'active');
		assert.deepEqual(narrowing.memory.supersedes, []);

		__test.reset();
		configure({ mode: 'auto', judge: 'local:judge' });
		const moving = (await putMemory(idFor('moving'), shared(), alice, context)).memory;
		models.generator = async (input) => {
			await putMemory(moving.id, { tags: ['edited-while-judged'] }, alice, ifMatch(1));
			return judgeByMarker(input);
		};
		const raced = await putMemory(idFor('raced'), shared(`${DISK} REPLACES`), bob, context);
		assert.equal(raced.candidates[0].applied, false);
		assert.equal(stored(moving.id).status, 'active');
	});

	it('keeps explicit supersedes authoritative and an identical retry mutation-free', async () => {
		const explicit = (await putMemory(idFor('explicit'), shared('pelican nesting begins in march'), alice, context))
			.memory;
		const judged = (await putMemory(idFor('judged'), shared(), alice, context)).memory;
		const input = shared(`${DISK} REPLACES`, { supersedes: [explicit.id] });
		const first = await putMemory(idFor('new'), input, bob, context);
		assert.deepEqual(first.memory.supersedes, [explicit.id, judged.id]);
		assert.deepEqual(first.memory.autoSupersedes, [judged.id]);

		const before = structuredClone(stored(idFor('new')));
		const retry = await putMemory(idFor('new'), input, bob, context);
		assert.equal(retry.created, false);
		assert.equal(retry.revision, 1);
		assert.deepEqual(stored(idFor('new')), before);
	});

	it('is advisory on a revise: supersedes cannot change after create', async () => {
		const old = (await putMemory(idFor('old'), shared(), alice, context)).memory;
		const mine = (await putMemory(idFor('mine'), shared('pelican nesting begins in march'), bob, context)).memory;
		const { candidates } = await putMemory(mine.id, { content: `${DISK} REPLACES` }, bob, ifMatch(1));
		assert.deepEqual(
			candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied })),
			[{ id: old.id, verdict: 'supersedes', applied: undefined }],
		);
		assert.equal(stored(old.id).status, 'active');
	});

	it('falls back to advisory candidates when it cannot embed before the create', async () => {
		const old = (await putMemory(idFor('old'), shared(), alice, context)).memory;
		const embed = models.embed;
		// Only the pre-transaction call fails; the table's own embedding of the row succeeds.
		models.embed = async () => {
			models.embed = embed;
			throw Object.assign(new Error('embedding backend rate limited'), { upstreamStatus: 429 });
		};
		let result;
		try {
			result = await putMemory(idFor('new'), shared(`${DISK} REPLACES`), bob, context);
		} finally {
			models.embed = embed;
		}
		assert.equal(result.created, true);
		assert.deepEqual(
			result.candidates.map(({ id, verdict, applied }) => ({ id, verdict, applied })),
			[{ id: old.id, verdict: 'supersedes', applied: undefined }],
		);
		assert.equal(stored(old.id).status, 'active');
	});

	it('spends no embedding or judge call on a create the transaction will refuse', async () => {
		await putMemory(idFor('old'), shared(), alice, context);
		const embedsBefore = models.calls.length;
		await rejection(putMemory(idFor('denied'), shared(DISK, { scopes: ['customer:x'] }), alice, context), 403);
		await rejection(putMemory(idFor('untitled'), { content: DISK, visibility: 'shared' }, alice, context), 400);
		assert.equal(models.calls.length, embedsBefore);
		assert.equal(models.generateCalls.length, 0);
	});
});
