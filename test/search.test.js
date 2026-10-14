import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from 'harper';
import { createMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { bootstrapMemories, fuse, parseBootstrapParams, parseSearchParams, searchMemories } from '../dist/search.js';

const alice = createPrincipal({ id: 'alice', grants: { read: ['global'], write: ['global'] } });
const dave = createPrincipal({ id: 'dave', grants: { read: ['customer:*'] } });
const root = createPrincipal({ id: 'root', superUser: true });
const context = {};
const params = (query) => parseSearchParams(new URLSearchParams(query));

const create = async (principal, key, overrides = {}) =>
	(await createMemory({ idempotencyKey: key, title: key, content: `${key} content`, ...overrides }, principal, context))
		.memory;

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('fuse', () => {
	it('scores 1/(60 + rank) per lane, so agreement between lanes ranks first', () => {
		const fused = fuse([
			[{ id: 'a' }, { id: 'b' }],
			[{ id: 'b' }, { id: 'c' }],
		]);
		assert.deepEqual(
			fused.map(({ record }) => record.id),
			['b', 'a', 'c'],
		);
		assert.equal(fused[0].score, 1 / 62 + 1 / 61);
		assert.equal(fused[1].score, 1 / 61);
	});

	it('breaks ties on id so ranking is deterministic', () => {
		assert.deepEqual(
			fuse([[{ id: 'z' }], [{ id: 'y' }]]).map(({ record }) => record.id),
			['y', 'z'],
		);
	});
});

describe('parseSearchParams', () => {
	it('defaults and bounds its parameters', () => {
		assert.deepEqual(params(''), { q: undefined, tags: [], scopes: [], limit: 10, includeSuperseded: false });
		assert.deepEqual(params('q=%20disk%20&tag=a&tag=b&scope=team:x&limit=5&includeSuperseded=true'), {
			q: 'disk',
			tags: ['a', 'b'],
			scopes: ['team:x'],
			limit: 5,
			includeSuperseded: true,
		});
		for (const bad of [
			'limit=0',
			'limit=51',
			'limit=two',
			'scope=team:*',
			'includeSuperseded=yes',
			`q=${'x'.repeat(1001)}`,
		]) {
			assert.throws(
				() => params(bad),
				(error) => error.statusCode === 400,
				bad,
			);
		}
	});

	it('bounds the bootstrap budget', () => {
		assert.equal(parseBootstrapParams(new URLSearchParams('')).budget, 8000);
		assert.throws(
			() => parseBootstrapParams(new URLSearchParams('budget=100001')),
			(error) => error.statusCode === 400,
		);
	});
});

describe('searchMemories', () => {
	it('pushes status and the readable set into both lanes, and the model into the vector lane', async () => {
		await searchMemories(params('q=disk'), dave, context);
		const [vector, text] = __test.searchLog;
		const readable = {
			operator: 'or',
			conditions: [
				{ attribute: 'ownerId', comparator: 'equals', value: 'dave' },
				{ attribute: 'scopes', comparator: 'equals', value: 'user:dave' },
				{ attribute: 'scopes', comparator: 'gelt', value: ['customer:', 'customer;'] },
			],
		};
		const status = { attribute: 'status', comparator: 'equals', value: 'active' };
		assert.deepEqual(vector.query.conditions, [
			status,
			readable,
			{ attribute: 'embeddingModel', comparator: 'equals', value: 'default' },
		]);
		assert.equal(vector.query.sort.attribute, 'embedding');
		assert.ok(vector.query.sort.waitForIndexMilliseconds > 0);
		assert.deepEqual(text.query.conditions.slice(0, 2), [status, readable]);
		assert.equal(text.query.conditions[2].comparator, 'matches');
		assert.ok(text.query.conditions[2].waitForIndexMilliseconds > 0);
		for (const lane of [vector, text]) assert.ok(!lane.query.select.includes('embedding'));
	});

	it('adds no readable condition for super_user, and admits superseded only when asked', async () => {
		await searchMemories(params('q=disk&includeSuperseded=true&tag=ops'), root, context);
		const [vector] = __test.searchLog;
		assert.deepEqual(vector.query.conditions.slice(0, 2), [
			{
				operator: 'or',
				conditions: [
					{ attribute: 'status', comparator: 'equals', value: 'active' },
					{ attribute: 'status', comparator: 'equals', value: 'superseded' },
				],
			},
			{ attribute: 'tags', comparator: 'equals', value: 'ops' },
		]);
		assert.equal(vector.query.conditions.length, 3);
	});

	it('returns only readable, non-withdrawn memories, ranked, with a score', async () => {
		const mine = await create(alice, 'disk alpha', { content: 'disk pressure on alpha' });
		const shared = await create(root, 'disk beta', { content: 'disk pressure on beta', visibility: 'shared' });
		await create(root, 'disk secret', { content: 'disk pressure secret', scopes: ['customer:x'] });
		const gone = await create(alice, 'disk gone', { content: 'disk pressure gone' });
		await withdrawMemory(gone.id, { expectedRevision: 1 }, alice, context);
		const hits = await searchMemories(params('q=disk'), alice, context);
		assert.deepEqual(hits.map((hit) => hit.id).sort(), [mine.id, shared.id].sort());
		assert.ok(hits.every((hit) => typeof hit.score === 'number' && hit.embedding === undefined));
	});

	it('lists by recency when there is no query', async () => {
		const first = await create(alice, 'first');
		const second = await create(alice, 'second');
		assert.deepEqual(
			(await searchMemories(params(''), alice, context)).map((hit) => hit.id),
			[second.id, first.id],
		);
	});

	it('queries the vector lane with the configured model', async () => {
		applySettings(parseSettings({ embeddingModel: 'local:small' }));
		await searchMemories(params('q=disk'), alice, context);
		const { models } = await import('harper');
		assert.deepEqual(models.calls.at(-1), { input: 'disk', options: { model: 'local:small', inputType: 'query' } });
		assert.deepEqual(__test.searchLog[0].query.conditions.at(-1), {
			attribute: 'embeddingModel',
			comparator: 'equals',
			value: 'local:small',
		});
	});
});

describe('bootstrapMemories', () => {
	it('orders pinned, recent, relevant; deduplicates; skips what does not fit', async () => {
		const pinned = await create(root, 'pin', { content: 'pinned guidance', pinned: true, visibility: 'shared' });
		const recent = await create(alice, 'mine', { content: 'my recent note' });
		const large = await create(alice, 'big', { content: 'y'.repeat(500) });
		const relevant = await create(root, 'tapir', { content: 'tapir facts', visibility: 'shared' });
		const result = await bootstrapMemories({ q: 'tapir', budget: 120 }, alice, context);
		assert.deepEqual(
			result.memories.map((memory) => [memory.id, memory.section]),
			[
				[pinned.id, 'pinned'],
				[recent.id, 'recent'],
				[relevant.id, 'relevant'],
			],
		);
		assert.ok(!result.memories.some((memory) => memory.id === large.id));
		assert.ok(result.used <= 120);
	});
});
