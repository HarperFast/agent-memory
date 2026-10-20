import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from 'harper';
import { importMemories } from '../dist/import.js';
import { pinMemory, putMemory, unpinMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { bootstrapMemories, fuse, parseBootstrapParams, parseSearchParams, searchMemories } from '../dist/search.js';

const alice = createPrincipal({ id: 'alice', grants: { read: ['global'], write: ['global'] } });
const bob = createPrincipal({ id: 'bob', grants: { read: ['global'], write: ['global'] } });
const dave = createPrincipal({ id: 'dave', grants: { read: ['customer:*'] } });
const root = createPrincipal({ id: 'root', superUser: true });
const context = {};
const params = (query) => parseSearchParams(new URLSearchParams(query));

const idFor = (principal, key) =>
	`mem-${principal.id}-${key.replace(/[^A-Za-z0-9_-]/g, '_')}--`.slice(0, 64).padEnd(16, '_');
const create = async (principal, key, overrides = {}) =>
	(await putMemory(idFor(principal, key), { title: key, content: `${key} content`, ...overrides }, principal, context))
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
		assert.deepEqual(params(''), {
			q: undefined,
			tags: [],
			scopes: [],
			limit: 10,
			includeSuperseded: false,
			includeExpired: false,
			flagged: false,
			watch: false,
		});
		assert.deepEqual(
			params(
				'q=%20disk%20&tag=a&tag=b&scope=team:x&limit=5&includeSuperseded=true&includeExpired=true&flagged=true&watch=true',
			),
			{
				q: 'disk',
				tags: ['a', 'b'],
				scopes: ['team:x'],
				limit: 5,
				includeSuperseded: true,
				includeExpired: true,
				flagged: true,
				watch: true,
			},
		);
		for (const bad of [
			'limit=0',
			'limit=51',
			'limit=two',
			'scope=team:*',
			'includeSuperseded=yes',
			'includeExpired=yes',
			'watch=yes',
			`q=${'x'.repeat(1001)}`,
		]) {
			assert.throws(
				() => params(bad),
				(error) => error.statusCode === 400,
				bad,
			);
		}
	});

	it('parses the created-order cursor and refuses it with q or without order', () => {
		const id = 'mem-cursor-row__';
		assert.deepEqual(params(`order=created&after=2025-06-01T00:00:00.000Z,${id}&limit=50`), {
			q: undefined,
			tags: [],
			scopes: [],
			limit: 50,
			includeSuperseded: false,
			includeExpired: false,
			flagged: false,
			watch: false,
			order: 'created',
			after: { createdAt: new Date('2025-06-01T00:00:00.000Z'), id },
		});
		for (const bad of [
			'order=updated',
			'order=created&q=disk',
			`after=2025-06-01T00:00:00.000Z,${id}`,
			'order=created&after=2025-06-01T00:00:00.000Z',
			'order=created&after=yesterday,mem-cursor-row__',
			'order=created&after=2025-06-01T00:00:00.000Z,short',
			`order=created&after=2025-06-01T00:00:00.000Z,${id},extra`,
		]) {
			assert.throws(
				() => params(bad),
				(error) => error.statusCode === 400,
				bad,
			);
		}
	});

	it('bounds the bootstrap budget and validates watch', () => {
		assert.deepEqual(parseBootstrapParams(new URLSearchParams('')), { q: undefined, budget: 8000, watch: false });
		assert.deepEqual(parseBootstrapParams(new URLSearchParams('watch=true')), {
			q: undefined,
			budget: 8000,
			watch: true,
		});
		assert.throws(
			() => parseBootstrapParams(new URLSearchParams('budget=100001')),
			(error) => error.statusCode === 400,
		);
		assert.throws(
			() => parseBootstrapParams(new URLSearchParams('watch=1')),
			(error) => error.statusCode === 400,
		);
	});
});

describe('searchMemories', () => {
	it('pushes status, expiry and the readable set into both lanes, and the model into the vector lane', async () => {
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
		const unexpired = vector.query.conditions[1];
		assert.equal(unexpired.operator, 'or');
		assert.deepEqual(unexpired.conditions[0], { attribute: 'validUntil', comparator: 'equals', value: null });
		assert.equal(unexpired.conditions[1].attribute, 'validUntil');
		assert.equal(unexpired.conditions[1].comparator, 'greater_than');
		assert.ok(unexpired.conditions[1].value instanceof Date);
		assert.deepEqual(vector.query.conditions, [
			status,
			unexpired,
			readable,
			{ attribute: 'embeddingModel', comparator: 'equals', value: 'default' },
		]);
		assert.equal(vector.query.sort.attribute, 'embedding');
		assert.ok(vector.query.sort.waitForIndexMilliseconds > 0);
		assert.deepEqual(text.query.conditions.slice(0, 3), [status, unexpired, readable]);
		assert.equal(text.query.conditions[3].comparator, 'matches');
		assert.ok(text.query.conditions[3].waitForIndexMilliseconds > 0);
		for (const lane of [vector, text]) assert.ok(!lane.query.select.includes('embedding'));
	});

	it('adds no readable condition for super_user, and admits superseded and expired only when asked', async () => {
		await searchMemories(params('q=disk&includeSuperseded=true&includeExpired=true&tag=ops'), root, context);
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

	it('excludes expired memories by default and includes them with includeExpired=true', async () => {
		const live = await create(alice, 'disk live', {
			content: 'disk pressure live',
			validUntil: '2099-01-01T00:00:00.000Z',
		});
		const expired = await create(alice, 'disk expired', {
			content: 'disk pressure expired',
			validUntil: '2020-01-01T00:00:00.000Z',
		});
		const timeless = await create(alice, 'disk timeless', { content: 'disk pressure timeless' });

		const defaultQueryHits = await searchMemories(params('q=disk'), alice, context);
		assert.deepEqual(defaultQueryHits.map((hit) => hit.id).sort(), [live.id, timeless.id].sort());

		const defaultListHits = await searchMemories(params(''), alice, context);
		assert.deepEqual(defaultListHits.map((hit) => hit.id).sort(), [live.id, timeless.id].sort());

		const withExpired = await searchMemories(params('q=disk&includeExpired=true'), alice, context);
		assert.deepEqual(withExpired.map((hit) => hit.id).sort(), [expired.id, live.id, timeless.id].sort());
	});

	it('returns only readable, non-withdrawn memories, ranked, with a score', async () => {
		const mine = await create(alice, 'disk alpha', { content: 'disk pressure on alpha' });
		const shared = await create(root, 'disk beta', { content: 'disk pressure on beta', visibility: 'shared' });
		await create(root, 'disk secret', { content: 'disk pressure secret', scopes: ['customer:x'] });
		const gone = await create(alice, 'disk gone', { content: 'disk pressure gone' });
		await withdrawMemory(gone.id, {}, alice, { headers: { 'if-match': '"1"' } });
		const hits = await searchMemories(params('q=disk'), alice, context);
		assert.deepEqual(hits.map((hit) => hit.id).sort(), [mine.id, shared.id].sort());
		assert.ok(hits.every((hit) => typeof hit.score === 'number' && hit.embedding === undefined));
	});

	it('serves full-text results when the configured model no longer matches the stored vectors', async () => {
		const stored = await create(alice, 'disk gamma', { content: 'disk pressure on gamma' });
		applySettings(parseSettings({ embeddingModel: 'wide' }));
		const hits = await searchMemories(params('q=disk'), alice, context);
		assert.deepEqual(
			hits.map((hit) => hit.id),
			[stored.id],
		);
	});

	it('serves full-text results when query embedding fails', async () => {
		const stored = await create(alice, 'disk outage', { content: 'disk pressure during embedder outage' });
		const { models } = await import('harper');
		const embed = models.embed;
		models.embed = async () => {
			throw Object.assign(new Error('embedding provider unavailable'), { upstreamStatus: 503 });
		};
		try {
			const hits = await searchMemories(params('q=disk'), alice, context);
			assert.deepEqual(
				hits.map((hit) => hit.id),
				[stored.id],
			);
			const boot = await bootstrapMemories({ q: 'disk', budget: 8000 }, alice, context);
			assert.deepEqual(
				boot.memories.map((m) => [m.id, m.section]),
				[[stored.id, 'recent']],
			);
		} finally {
			models.embed = embed;
		}
	});

	it('still fails a search when the vector lane fails for any other reason, including non-mismatch 400', async () => {
		await create(alice, 'disk delta', { content: 'disk pressure on delta' });
		const Memory = (await import('harper')).databases.memory.Memory;
		const search = Memory.search;
		Memory.search = function (query, ctx) {
			if (query.sort?.target) throw Object.assign(new Error('backend down'), { statusCode: 503 });
			return search.call(this, query, ctx);
		};
		try {
			await assert.rejects(searchMemories(params('q=disk'), alice, context), /backend down/);
			Memory.search = function (query, ctx) {
				if (query.sort?.target) throw Object.assign(new Error('invalid query syntax'), { statusCode: 400 });
				return search.call(this, query, ctx);
			};
			await assert.rejects(searchMemories(params('q=disk'), alice, context), /invalid query syntax/);
		} finally {
			Memory.search = search;
		}
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

describe('created-order cursor', () => {
	const at = '2025-06-01T00:00:00.000Z';
	const rowId = (n) => `cursor-row-${String(n).padStart(2, '0')}`.padEnd(16, '_');
	const walk = async (principal, query, limit) => {
		const seen = [];
		let after = '';
		for (let page = 0; page < 20; page++) {
			const memories = await searchMemories(params(`order=created&limit=${limit}${query}${after}`), principal, context);
			assert.ok(memories.length <= limit);
			seen.push(...memories.map((memory) => memory.id));
			if (memories.length < limit) return seen;
			const last = memories.at(-1);
			after = `&after=${last.createdAt},${last.id}`;
		}
		throw new Error('walk did not end');
	};

	it('pages oldest first by createdAt then id, exactly limit rows a page, across a same-timestamp batch', async () => {
		await importMemories(
			{
				rows: [
					{ id: rowId(90), ownerId: 'alice', content: 'last', scopes: ['global'], createdAt: '2025-07-01T00:00:00Z' },
					...[7, 3, 5, 1, 6, 2, 4].map((n) => ({
						id: rowId(n),
						ownerId: 'alice',
						content: `same ${n}`,
						scopes: ['global'],
						createdAt: at,
					})),
					{ id: rowId(0), ownerId: 'alice', content: 'first', scopes: ['global'], createdAt: '2025-01-01T00:00:00Z' },
				],
			},
			root,
			context,
		);
		const expected = [0, 1, 2, 3, 4, 5, 6, 7, 90].map(rowId);
		for (const limit of [1, 2, 3, 50]) assert.deepEqual(await walk(alice, '', limit), expected, `limit ${limit}`);
		const search = __test.searchLog.at(-1).query;
		assert.deepEqual(search.sort, { attribute: 'createdAt', next: { attribute: 'id' } });
	});

	it('pins the createdAt scan only for an unfiltered super_user walk', async () => {
		const pinned = async (principal, query) => {
			await searchMemories(params(`order=created${query}`), principal, context);
			return __test.searchLog.at(-1).query.enforceExecutionOrder;
		};
		assert.equal(await pinned(root, ''), true);
		assert.equal(await pinned(root, '&tag=ops'), false);
		assert.equal(await pinned(root, '&scope=team:x'), false);
		assert.equal(await pinned(root, '&flagged=true'), false);
		assert.equal(await pinned(alice, ''), false);
	});

	it('keeps the readable-set and status conditions in the query', async () => {
		await importMemories(
			{
				rows: [
					{ id: rowId(1), ownerId: 'carol', content: 'secret', scopes: ['customer:x'], createdAt: at },
					{ id: rowId(2), ownerId: 'alice', content: 'old', scopes: ['global'], createdAt: at },
					{ id: rowId(3), ownerId: 'alice', content: 'new', scopes: ['global'], supersedes: [rowId(2)], createdAt: at },
				],
			},
			root,
			context,
		);
		assert.deepEqual(await walk(alice, '', 1), [rowId(3)]);
		assert.deepEqual(await walk(alice, '&includeSuperseded=true', 1), [rowId(2), rowId(3)]);
		assert.deepEqual(await walk(root, '&includeSuperseded=true', 1), [1, 2, 3].map(rowId));
	});
});

describe('bootstrapMemories', () => {
	it('orders pinned (newest pin first even when an older pin is revised), recent, relevant; deduplicates; skips what does not fit', async () => {
		const olderPin = await create(root, 'pin-old', { content: 'older pin', visibility: 'shared' });
		const newerPin = await create(root, 'pin-new', { content: 'newer pin', visibility: 'shared' });
		await pinMemory(olderPin.id, {}, alice, context);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await pinMemory(newerPin.id, {}, alice, context);
		// Revise olderPin so its updatedAt is newer than newerPin's; pinned section must still rank newerPin first.
		await putMemory(olderPin.id, { content: 'older pin revised' }, root, { headers: { 'if-match': '"1"' } });

		const recent = await create(alice, 'mine', { content: 'my recent note' });
		const large = await create(alice, 'big', { content: 'y'.repeat(500) });
		const relevant = await create(root, 'tapir', { content: 'tapir facts', visibility: 'shared' });
		const result = await bootstrapMemories({ q: 'tapir', budget: 200 }, alice, context);
		const pinSearch = __test.searchLog.findLast((entry) => entry.table === 'MemoryPin');
		assert.deepEqual(pinSearch.query.sort, { attribute: 'createdAt', descending: true });
		assert.equal(pinSearch.query.limit, 50);
		assert.deepEqual(
			result.memories.map((memory) => [memory.id, memory.section]),
			[
				[newerPin.id, 'pinned'],
				[olderPin.id, 'pinned'],
				[recent.id, 'recent'],
				[relevant.id, 'relevant'],
			],
		);
		assert.ok(!result.memories.some((memory) => memory.id === large.id));
		assert.ok(result.used <= 200);
	});

	it('isolates pins per reader and excludes expired memories from every bootstrap section', async () => {
		const shared = await create(root, 'shared-guide', { content: 'shared guide', visibility: 'shared' });
		await pinMemory(shared.id, {}, bob, context);

		const expiredPin = await create(root, 'expired-pin', {
			content: 'expired pinned guidance',
			visibility: 'shared',
			validUntil: '2020-01-01T00:00:00.000Z',
		});
		await pinMemory(expiredPin.id, {}, alice, context);
		await create(alice, 'expired-recent', {
			content: 'expired recent note',
			validUntil: '2020-01-01T00:00:00.000Z',
		});
		await create(root, 'expired-relevant', {
			content: 'tapir expired facts',
			visibility: 'shared',
			validUntil: '2020-01-01T00:00:00.000Z',
		});

		const bobBootstrap = await bootstrapMemories({ budget: 8000 }, bob, context);
		assert.deepEqual(
			bobBootstrap.memories.map((memory) => [memory.id, memory.section]),
			[[shared.id, 'pinned']],
		);

		assert.deepEqual((await bootstrapMemories({ budget: 8000 }, alice, context)).memories, []);
		const aliceWithQuery = await bootstrapMemories({ q: 'tapir', budget: 8000 }, alice, context);
		assert.deepEqual(
			aliceWithQuery.memories.map((memory) => [memory.id, memory.section]),
			[[shared.id, 'relevant']],
		);

		await unpinMemory(shared.id, {}, bob, context);
		assert.deepEqual((await bootstrapMemories({ budget: 8000 }, bob, context)).memories, []);
	});
});
