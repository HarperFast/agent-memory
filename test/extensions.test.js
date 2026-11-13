import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { __test, databases, logger } from 'harper';
import { loadBootstrapCache, loadSessionState } from '../claude-plugin/lib/cache.mjs';
import { resolveConfig } from '../claude-plugin/lib/config.mjs';
import { handleSessionStart } from '../claude-plugin/lib/hooks.mjs';
import { annotateSearchHits } from '../dist/extensions.js';
import { getMemories, registerBootstrapSection, registerSearchAnnotator, scanMemories } from '../dist/index.js';
import { pinMemory, putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { MemoryBootstrapResource, MemoryMcpResource, MemoryResource } from '../dist/resource.js';
import { domain } from '../dist/runtime.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { bootstrapMemories, parseSearchParams, searchMemories } from '../dist/search.js';

const alice = createPrincipal({ id: 'alice', grants: { read: ['global'], write: ['global'] } });
const root = createPrincipal({ id: 'root', superUser: true });
const context = {};
const aliceUser = { username: 'alice' };
const idFor = (key) => `mem-${key}--`.padEnd(16, '_');
const create = async (principal, key, overrides = {}) =>
	(await putMemory(idFor(key), { title: key, content: `${key} content`, ...overrides }, principal, context)).memory;
const queryTarget = (query = '') => new URLSearchParams(query);
const sectionsOf = (result) => result.memories.map((entry) => [entry.id ?? null, entry.section]);

const unregisters = [];
const register = (fn, entry) => {
	const unregister = fn(entry);
	unregisters.push(unregister);
	return unregister;
};
const errors = [];
const originalError = logger.error;

beforeEach(async () => {
	__test.reset();
	applySettings(parseSettings({}));
	errors.length = 0;
	logger.error = (...args) => errors.push(args);
	await databases.memory.ScopeGrant.put({ id: 'user:alice', read: ['global'], write: ['global'] });
});

afterEach(() => {
	for (const unregister of unregisters.splice(0)) unregister();
	logger.error = originalError;
});

describe('getMemories', () => {
	const seedRow = (id, overrides = {}) =>
		__test.stores.get('Memory').set(id, {
			id,
			title: id,
			content: `content of ${id}`,
			scopes: ['global', 'team:a'],
			ownerId: 'alice',
			status: 'active',
			revision: 1,
			embedding: [id.length, 1],
			embeddingModel: 'default',
			validUntil: null,
			createdAt: new Date(Date.UTC(2026, 0, 1)),
			updatedAt: new Date(Date.UTC(2026, 0, 1)),
			...overrides,
		});

	it('returns rows in the order asked, with the vector, its model and the scopes, and leaves out unknown ids', async () => {
		for (const id of ['mem-a', 'mem-bb', 'mem-ccc']) seedRow(id);
		const rows = await getMemories(['mem-ccc', 'mem-missing', 'mem-a', 'mem-ccc']);
		assert.deepEqual(
			rows.map((row) => row.id),
			['mem-ccc', 'mem-a'],
		);
		assert.deepEqual(rows[0].embedding, [7, 1]);
		assert.equal(rows[0].embeddingModel, 'default');
		assert.deepEqual(rows[0].scopes, ['global', 'team:a']);
		assert.ok(rows[0].createdAt instanceof Date);
	});

	it('returns withdrawn, superseded, expired, flagged and review-pending rows', async () => {
		seedRow('mem-withdrawn', { status: 'withdrawn' });
		seedRow('mem-superseded', { status: 'superseded', supersededBy: idFor('next') });
		seedRow('mem-expired', { validUntil: new Date('2020-01-01T00:00:00Z') });
		seedRow('mem-flagged', {
			needsReview: true,
			contentFlag: { kind: 'possible-customer-detail', since: '2026-01-01T00:00:00.000Z', source: 'pattern' },
		});
		const rows = await getMemories(['mem-withdrawn', 'mem-superseded', 'mem-expired', 'mem-flagged']);
		assert.deepEqual(
			rows.map((row) => row.status),
			['withdrawn', 'superseded', 'active', 'active'],
		);
		assert.equal(rows[3].needsReview, true);
		assert.equal(rows[3].contentFlag.kind, 'possible-customer-detail');
		assert.equal(rows[2].validUntil.getUTCFullYear(), 2020);
	});

	it('reads in queries of at most 100 ids, keeping the order across them', async () => {
		const ids = Array.from({ length: 230 }, (_, i) => `mem-${String(i).padStart(4, '0')}`);
		for (const id of ids) seedRow(id);
		const asked = [...ids].reverse();
		__test.searchLog.length = 0;
		assert.deepEqual(
			(await getMemories(asked)).map((row) => row.id),
			asked,
		);
		const queries = __test.searchLog.filter((entry) => entry.table === 'Memory');
		assert.deepEqual(
			queries.map((entry) => entry.query.limit),
			[100, 100, 30],
		);
	});

	it('answers an empty list without a query, and rejects an id that is not a string', async () => {
		__test.searchLog.length = 0;
		assert.deepEqual(await getMemories([]), []);
		assert.equal(__test.searchLog.length, 0);
		await assert.rejects(getMemories(['mem-a', 7]), TypeError);
	});
});

describe('scanMemories', () => {
	// Rows written straight to the store, so createdAt can be shared the way an import preserving source time does.
	const seed = (count, createdAtFor, overridesFor = () => ({})) => {
		const rows = __test.stores.get('Memory');
		for (let i = 0; i < count; i++) {
			const id = `mem-scan-${String(i).padStart(4, '0')}`.padEnd(16, '_');
			rows.set(id, {
				id,
				title: `row ${i}`,
				content: `content ${i}`,
				scopes: ['global'],
				ownerId: 'alice',
				status: 'active',
				revision: 1,
				embedding: [i, 1],
				embeddingModel: 'default',
				validUntil: null,
				createdAt: createdAtFor(i),
				updatedAt: createdAtFor(i),
				...overridesFor(i),
			});
		}
	};
	const collectScan = async (options) => {
		const rows = [];
		for await (const row of scanMemories(options)) rows.push(row);
		return rows;
	};
	const scanPages = () =>
		__test.searchLog.filter((entry) => entry.table === 'Memory' && entry.query.enforceExecutionOrder === true);

	it('yields active, unexpired rows as stored, oldest createdAt first then id, with the vector and its model', async () => {
		const day = (n) => new Date(Date.UTC(2026, 0, n));
		seed(
			6,
			(i) => day(10 - i),
			(i) =>
				[
					{},
					{ status: 'withdrawn' },
					{ status: 'superseded', supersededBy: idFor('next') },
					{ validUntil: new Date('2020-01-01T00:00:00Z') },
					{ validUntil: new Date('2999-01-01T00:00:00Z') },
					{ contentFlag: { kind: 'possible-customer-detail', since: day(1).toISOString(), source: 'pattern' } },
				][i],
		);
		const rows = await collectScan();
		assert.deepEqual(
			rows.map((row) => row.title),
			['row 5', 'row 4', 'row 0'],
		);
		const [flagged] = rows;
		assert.ok(flagged.createdAt instanceof Date);
		assert.deepEqual(flagged.embedding, [5, 1]);
		assert.equal(flagged.embeddingModel, 'default');
		assert.equal(flagged.contentFlag.kind, 'possible-customer-detail');
		assert.ok(Object.isFrozen(flagged));
		assert.equal(scanPages()[0].query.sort.next.attribute, 'id');
	});

	it('yields every row with includeInactive', async () => {
		seed(
			4,
			() => new Date(Date.UTC(2026, 0, 1)),
			(i) => ({
				status: ['active', 'withdrawn', 'superseded', 'active'][i],
				validUntil: i === 3 ? new Date('2020-01-01T00:00:00Z') : null,
			}),
		);
		assert.deepEqual(
			(await collectScan({ includeInactive: true })).map((row) => row.status),
			['active', 'withdrawn', 'superseded', 'active'],
		);
	});

	it('pages through a same-createdAt group larger than a page, and resumes from any row without a skip or a repeat', async () => {
		// 40 older rows, then 180 sharing one timestamp, so pages of 100 end inside the group.
		const shared = new Date(Date.UTC(2026, 2, 1));
		seed(220, (i) => (i < 40 ? new Date(Date.UTC(2026, 1, 1) + i * 1000) : shared));
		const all = await collectScan();
		assert.equal(all.length, 220);
		assert.equal(new Set(all.map((row) => row.id)).size, 220);
		assert.deepEqual(
			all.map((row) => row.id),
			[...__test.stores.get('Memory').keys()].sort(),
		);
		assert.equal(scanPages().length, 3);
		assert.ok(scanPages().every((entry) => entry.query.limit === 100));

		for (const index of [39, 40, 99, 100, 150, 218]) {
			const last = all[index];
			const rest = await collectScan({ after: { createdAt: last.createdAt, id: last.id } });
			assert.deepEqual(
				rest.map((row) => row.id),
				all.slice(index + 1).map((row) => row.id),
				`after row ${index}`,
			);
		}
		const last = all.at(-1);
		assert.deepEqual(await collectScan({ after: { createdAt: last.createdAt.toISOString(), id: last.id } }), []);
	});

	it('keeps its own cursor when the consumer mutates the createdAt it was handed', async () => {
		seed(250, (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000));
		const ids = [];
		for await (const row of scanMemories()) {
			ids.push(row.id);
			row.createdAt.setUTCFullYear(2000);
		}
		assert.deepEqual(ids, [...__test.stores.get('Memory').keys()].sort());
	});

	it('accepts a cursor Date from another realm and rejects a malformed cursor', async () => {
		seed(3, (i) => new Date(Date.UTC(2026, 0, 1 + i)));
		const [first] = await collectScan();
		const foreign = runInNewContext(`new Date(${first.createdAt.getTime()})`);
		assert.equal(foreign instanceof Date, false);
		assert.equal((await collectScan({ after: { createdAt: foreign, id: first.id } })).length, 2);
		for (const after of [{ createdAt: 'not a date', id: first.id }, { createdAt: first.createdAt }, {}]) {
			await assert.rejects(collectScan({ after }), TypeError);
		}
	});
});

describe('registerBootstrapSection', () => {
	const setUp = async () => {
		const guide = await create(root, 'guide', { content: 'pinned guide', visibility: 'shared' });
		await pinMemory(guide.id, {}, alice, context);
		const source = await create(root, 'source', { content: 'kernel guidance', visibility: 'shared' });
		const citer = await create(alice, 'citer', {
			content: 'my conclusion',
			evidence: [{ kind: 'memory', ref: source.id }],
		});
		await putMemory(
			idFor('next'),
			{ title: 'next', content: 'tapir kernel guidance, corrected', visibility: 'shared', supersedes: [source.id] },
			root,
			context,
		);
		const mine = await create(alice, 'mine', { content: 'my recent note' });
		return { guide, citer, mine };
	};

	it('packs a section after pinned and needsReview and before recent and relevant, told the budget they left', async () => {
		const { guide, citer, mine } = await setUp();
		const calls = [];
		register(registerBootstrapSection, {
			name: 'orientation',
			render(input) {
				calls.push(input);
				return [
					{ title: 'Topics', content: 'kernels, tapirs' },
					{ content: 'x'.repeat(10_000) },
					{ content: 'storage' },
				];
			},
		});
		register(registerBootstrapSection, { name: 'second', render: async () => ({ text: 'second section' }) });

		const result = await bootstrapMemories({ q: 'tapir', budget: 8000 }, alice, context);
		assert.deepEqual(sectionsOf(result), [
			[guide.id, 'pinned'],
			[citer.id, 'needsReview'],
			[null, 'orientation'],
			[null, 'orientation'],
			[null, 'second'],
			[mine.id, 'recent'],
			[idFor('next'), 'relevant'],
		]);
		const contributed = result.memories.filter((entry) => entry.id === undefined);
		assert.deepEqual(contributed, [
			{ title: 'Topics', content: 'kernels, tapirs', section: 'orientation' },
			{ title: null, content: 'storage', section: 'orientation' },
			{ title: null, content: 'second section', section: 'second' },
		]);
		const headChars = ['guide', 'pinned guide', 'citer', 'my conclusion'].join('').length;
		assert.equal(calls.length, 1);
		assert.equal(calls[0].budgetChars, 8000 - headChars);
		assert.equal(calls[0].principal, alice);
		assert.equal(calls[0].q, 'tapir');
		assert.equal(calls[0].context, context);
		assert.ok(Object.isFrozen(calls[0]));
		assert.ok(result.used <= 8000);
	});

	it('never lets contributed output exceed the budget, and leaves less for recent and relevant', async () => {
		await setUp();
		register(registerBootstrapSection, {
			name: 'orientation',
			render: ({ budgetChars }) => ({ text: 'o'.repeat(budgetChars) }),
		});
		const result = await bootstrapMemories({ q: 'tapir', budget: 100 }, alice, context);
		assert.deepEqual(
			result.memories.map((entry) => entry.section),
			['pinned', 'needsReview', 'orientation'],
		);
		assert.equal(result.used, 100);

		unregisters.pop()();
		register(registerBootstrapSection, {
			name: 'orientation',
			render: ({ budgetChars }) => ({ text: 'o'.repeat(budgetChars + 1) }),
		});
		const over = await bootstrapMemories({ q: 'tapir', budget: 100 }, alice, context);
		assert.ok(!over.memories.some((entry) => entry.section === 'orientation'));
		assert.ok(over.used <= 100);
	});

	it('omits a section that throws, rejects or returns another shape, logging each at most once a minute', async () => {
		await setUp();
		const broken = {
			throws: () => {
				throw new Error('boom');
			},
			rejects: async () => {
				throw new Error('async boom');
			},
			wrongShape: () => 'just a string',
			badItem: () => [{ content: 42 }],
			badTitle: () => [{ title: 7, content: 'x' }],
		};
		for (const [name, render] of Object.entries(broken)) register(registerBootstrapSection, { name, render });
		register(registerBootstrapSection, { name: 'healthy', render: () => [{ content: 'fine' }] });

		for (let i = 0; i < 2; i++) {
			const result = await bootstrapMemories({ budget: 8000 }, alice, context);
			assert.deepEqual(
				result.memories.filter((entry) => entry.id === undefined).map((entry) => entry.section),
				['healthy'],
			);
		}
		assert.deepEqual(
			errors.map(([message]) => message.match(/"(\w+)"/)[1]),
			Object.keys(broken),
		);
	});

	it('still answers when the logger itself throws while reporting a failed section', async () => {
		logger.error = () => {
			throw new Error('logger down');
		};
		register(registerBootstrapSection, {
			name: 'loggerProbe',
			render: () => {
				throw new Error('boom');
			},
		});
		assert.deepEqual((await bootstrapMemories({ budget: 8000 }, alice, context)).memories, []);
	});

	it('rejects with the failing load while a section still renders, leaving no rejection unobserved', async () => {
		await setUp();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const Memory = databases.memory.Memory;
		const search = Memory.search;
		Memory.search = function (query, ctx) {
			if (query.sort?.attribute === 'updatedAt' && query.limit === 50) {
				return (async function* () {
					throw new Error('recent load failed');
				})();
			}
			return search.call(this, query, ctx);
		};
		let rendered = false;
		try {
			register(registerBootstrapSection, {
				name: 'slow',
				render: async () => {
					await new Promise((resolve) => setTimeout(resolve, 30));
					rendered = true;
					return [{ content: 'late' }];
				},
			});
			await assert.rejects(bootstrapMemories({ budget: 8000 }, alice, context), /recent load failed/);
			await new Promise((resolve) => setTimeout(resolve, 60));
			assert.equal(rendered, true);
			assert.deepEqual(unhandled, []);
		} finally {
			Memory.search = search;
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('rejects cleanly when every query throws synchronously, with or without a section', async () => {
		await setUp();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const Memory = databases.memory.Memory;
		const search = Memory.search;
		Memory.search = () => {
			throw new Error('database closed');
		};
		try {
			await assert.rejects(bootstrapMemories({ q: 'tapir', budget: 8000 }, alice, context), /database closed/);
			register(registerBootstrapSection, { name: 'orientation', render: () => [] });
			await assert.rejects(bootstrapMemories({ q: 'tapir', budget: 8000 }, alice, context), /database closed/);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(unhandled, []);
		} finally {
			Memory.search = search;
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('warns when an older plugin publishes after a section registered, and once per runtime', async () => {
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (message) => warnings.push(message);
		const target = domain();
		try {
			register(registerBootstrapSection, { name: 'orientation', render: () => [] });
			assert.deepEqual(warnings, []);
			target.runtime = { version: '0.1.4', resolvePrincipal() {}, canReadLabels() {} };
			assert.equal(warnings.length, 1);
			for await (const _row of scanMemories());
			register(registerSearchAnnotator, { name: 'summaries', annotate: () => undefined });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /running plugin is 0\.1\.4/);
		} finally {
			target.runtime = undefined;
			logger.warn = originalWarn;
		}
	});

	it('warns once when the running plugin predates sections and annotators', () => {
		const warnings = [];
		const originalWarn = logger.warn;
		logger.warn = (message) => warnings.push(message);
		const target = domain();
		target.runtime = { version: '0.1.4', resolvePrincipal() {}, canReadLabels() {} };
		try {
			register(registerBootstrapSection, { name: 'orientation', render: () => [] });
			register(registerSearchAnnotator, { name: 'summaries', annotate: () => undefined });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /running plugin is 0\.1\.4, which never renders bootstrap sections/);
		} finally {
			target.runtime = undefined;
			logger.warn = originalWarn;
		}
	});

	it('gives contributed entries no id, so watch=true watches memories only and the Claude client neither watches nor caches them', async () => {
		const { guide, citer, mine } = await setUp();
		register(registerBootstrapSection, {
			name: 'orientation',
			render: () => [{ title: 'Topics', content: 'Main areas: kernels and tapirs.' }],
		});
		const response = await MemoryBootstrapResource.get(queryTarget('budget=4000&watch=true'), { user: aliceUser });
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(
			[...__test.stores.get('MemoryWatch').values()].map((row) => row.memoryId).sort(),
			[guide.id, citer.id, mine.id].sort(),
		);

		const cacheDir = mkdtempSync(join(tmpdir(), 'agent-memory-sections-'));
		try {
			const env = {
				AGENT_MEMORY_URL: 'https://memory.example.com',
				AGENT_MEMORY_TOKEN: 'secret-token',
				AGENT_MEMORY_USER: 'alice',
				AGENT_MEMORY_CACHE_DIR: cacheDir,
				AGENT_MEMORY_FOLLOWER: 'off',
			};
			const config = resolveConfig(env);
			const started = await handleSessionStart(
				{ session_id: 'sess-sections', source: 'startup' },
				{
					config,
					env,
					spawnFollower: false,
					nonce: 'aaaa1111bbbb2222',
					fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
				},
			);
			const text = started.hookSpecificOutput.additionalContext;
			const dataBlock = text.slice(text.indexOf('<agent-memory-data-aaaa1111bbbb2222'));
			assert.ok(dataBlock.includes('section="orientation"]\nTitle: Topics\nMain areas: kernels and tapirs.'));
			const state = loadSessionState(config, 'sess-sections');
			assert.deepEqual(state.watchedIds.sort(), [guide.id, citer.id, mine.id].sort());
			assert.ok(!loadBootstrapCache(config).memories.some((entry) => entry.section === 'orientation'));
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it('rejects a bad name, a built-in or taken name, or no render function, and stops rendering once unregistered', async () => {
		for (const name of ['', '1abc', 'has space', '__proto__', 'x'.repeat(65), undefined]) {
			assert.throws(() => registerBootstrapSection({ name, render: () => [] }), TypeError, String(name));
		}
		for (const name of ['pinned', 'needsReview', 'recent', 'relevant']) {
			assert.throws(() => registerBootstrapSection({ name, render: () => [] }), /reserved/);
		}
		assert.throws(() => registerBootstrapSection({ name: 'orientation' }), /render function/);
		let renders = 0;
		const unregister = register(registerBootstrapSection, {
			name: 'orientation',
			render: () => {
				renders++;
				return [{ content: 'x' }];
			},
		});
		assert.throws(() => registerBootstrapSection({ name: 'orientation', render: () => [] }), /already registered/);
		await bootstrapMemories({ budget: 8000 }, alice, context);
		unregister();
		await bootstrapMemories({ budget: 8000 }, alice, context);
		assert.equal(renders, 1);
		register(registerBootstrapSection, { name: 'orientation', render: () => [] });
	});
});

describe('registerSearchAnnotator', () => {
	const seedHits = async () => {
		const first = await create(alice, 'heron-one', { content: 'heron wading', visibility: 'shared' });
		const second = await create(alice, 'heron-two', { content: 'heron fishing heron', visibility: 'shared' });
		const third = await create(alice, 'egret', { content: 'egret heron', visibility: 'shared' });
		return [first, second, third];
	};
	const restSearch = async (query) => {
		const response = await MemoryResource.get(queryTarget(query), { user: aliceUser });
		assert.equal(response.status, 200);
		return (await response.json()).memories;
	};

	it('attaches each annotator value under its name on REST and MCP searches, leaving the hits and their order alone', async () => {
		await seedHits();
		const baseline = await restSearch('q=heron');
		const seen = [];
		register(registerSearchAnnotator, {
			name: 'summaries',
			annotate({ principal, hits }) {
				seen.push({ principal, ids: hits.map((hit) => hit.id), frozen: Object.isFrozen(hits) });
				return new Map([
					[hits[0].id, [{ node: 'n1', size: 37 }]],
					[hits[1].id, { node: 'n2' }],
					['mem-not-a-hit-0000', 'ignored'],
					[hits[2].id, undefined],
				]);
			},
		});
		register(registerSearchAnnotator, {
			name: 'clusters',
			annotate: async ({ hits }) => new Map(hits.map((hit, index) => [hit.id, index])),
		});

		const annotated = await restSearch('q=heron');
		assert.deepEqual(
			annotated.map(({ summaries: _s, clusters: _c, ...hit }) => hit),
			baseline,
		);
		assert.deepEqual(
			annotated.map((hit) => [hit.summaries, hit.clusters]),
			[
				[[{ node: 'n1', size: 37 }], 0],
				[{ node: 'n2' }, 1],
				[undefined, 2],
			],
		);
		assert.ok(!('summaries' in annotated[2]));
		assert.equal(seen[0].principal.id, 'alice');
		assert.deepEqual(
			seen[0].ids,
			baseline.map((hit) => hit.id),
		);
		assert.equal(seen[0].frozen, true);

		const recalled = await new MemoryMcpResource().mcpRecall({ q: 'heron' }, { user: aliceUser });
		assert.deepEqual(
			recalled.memories.map((hit) => [hit.id, hit.clusters]),
			baseline.map((hit, index) => [hit.id, index]),
		);
	});

	it('cannot add, remove or reorder hits, and the healthy annotators still apply', async () => {
		await seedHits();
		const baseline = await restSearch('q=heron');
		const attempts = {
			sorts: ({ hits }) => hits.sort(() => -1),
			pops: ({ hits }) => hits.pop(),
			pushes: ({ hits }) => hits.push({ id: 'mem-injected-00000' }),
		};
		for (const [name, annotate] of Object.entries(attempts)) register(registerSearchAnnotator, { name, annotate });
		register(registerSearchAnnotator, { name: 'healthy', annotate: ({ hits }) => new Map([[hits[0].id, true]]) });

		const annotated = await restSearch('q=heron');
		assert.deepEqual(
			annotated.map(({ healthy: _h, ...hit }) => hit),
			baseline,
		);
		assert.equal(annotated[0].healthy, true);
		assert.deepEqual(
			errors.map(([message]) => message.match(/"(\w+)"/)[1]),
			Object.keys(attempts),
		);
	});

	it('skips an annotator that throws, rejects or returns something other than a Map', async () => {
		await seedHits();
		const broken = {
			throws: () => {
				throw new Error('boom');
			},
			rejects: async () => {
				throw new Error('async boom');
			},
			plainObject: ({ hits }) => ({ [hits[0].id]: 1 }),
		};
		for (const [name, annotate] of Object.entries(broken)) register(registerSearchAnnotator, { name, annotate });
		register(registerSearchAnnotator, { name: 'healthy', annotate: ({ hits }) => new Map([[hits[0].id, 'ok']]) });

		const annotated = await restSearch('q=heron');
		assert.equal(annotated[0].healthy, 'ok');
		for (const name of Object.keys(broken))
			assert.ok(
				annotated.every((hit) => !(name in hit)),
				name,
			);
		assert.deepEqual(
			errors.map(([message]) => message.match(/"(\w+)"/)[1]),
			Object.keys(broken),
		);
	});

	it("reads a Map from another app's realm", async () => {
		const [first] = await seedHits();
		const value = { node: 'n1' };
		register(registerSearchAnnotator, {
			name: 'summaries',
			annotate: () => {
				const map = runInNewContext('new Map()');
				map.set(first.id, value);
				return map;
			},
		});
		const hits = await searchMemories(parseSearchParams(new URLSearchParams('q=wading')), alice, context);
		await annotateSearchHits(hits, alice, context);
		assert.equal(hits[0].summaries, value);
	});

	it('does no work without an annotator, and annotates neither q-less listings nor bootstrap', async () => {
		await seedHits();
		await create(root, 'heron-shared', { content: 'heron shared by root', visibility: 'shared' });
		const hits = await searchMemories(parseSearchParams(new URLSearchParams('q=heron')), alice, context);
		assert.equal(annotateSearchHits(hits, alice, context), undefined);

		let calls = 0;
		register(registerSearchAnnotator, {
			name: 'summaries',
			annotate: ({ hits: given }) => {
				calls++;
				return new Map(given.map((hit) => [hit.id, 1]));
			},
		});
		for (const query of ['', 'order=created', 'flagged=true']) {
			assert.ok(
				(await restSearch(query)).every((hit) => !('summaries' in hit)),
				query,
			);
		}
		const recalled = await new MemoryMcpResource().mcpRecall({}, { user: aliceUser });
		assert.ok(recalled.memories.length > 0 && recalled.memories.every((hit) => !('summaries' in hit)));
		const booted = await bootstrapMemories({ q: 'heron', budget: 8000 }, alice, context);
		assert.ok(booted.memories.some((entry) => entry.section === 'relevant'));
		assert.ok(booted.memories.every((entry) => !('summaries' in entry)));
		assert.equal(calls, 0);
	});

	it('dispatches under the name it checked, whatever the registered object later says', async () => {
		await seedHits();
		const annotator = { name: 'notes', annotate: ({ hits }) => new Map(hits.map((hit) => [hit.id, 'note'])) };
		register(registerSearchAnnotator, annotator);
		annotator.name = 'title';
		annotator.annotate = () => {
			throw new Error('replaced');
		};
		const [hit] = await restSearch('q=wading');
		assert.equal(hit.title, 'heron-one');
		assert.equal(hit.notes, 'note');
	});

	it('rejects a name a hit already carries, a taken name, or no annotate function', () => {
		for (const name of ['title', 'content', 'scopes', 'author', 'score', 'updatedAt']) {
			assert.throws(() => registerSearchAnnotator({ name, annotate: () => undefined }), /reserved/, name);
		}
		assert.throws(() => registerSearchAnnotator({ name: 'bad name', annotate: () => undefined }), TypeError);
		assert.throws(() => registerSearchAnnotator({ name: 'summaries' }), /annotate function/);
		register(registerSearchAnnotator, { name: 'summaries', annotate: () => undefined });
		assert.throws(() => registerSearchAnnotator({ name: 'summaries', annotate: () => undefined }), /already/);
	});
});

describe('withdrawn memories and annotations', () => {
	it('hands annotators only the readable hits the search returned', async () => {
		const kept = await create(alice, 'kept-heron', { content: 'heron kept', visibility: 'shared' });
		const gone = await create(alice, 'gone-heron', { content: 'heron gone', visibility: 'shared' });
		await withdrawMemory(gone.id, {}, alice, { headers: { 'if-match': '"1"' } });
		const given = [];
		register(registerSearchAnnotator, {
			name: 'summaries',
			annotate: ({ hits }) => {
				given.push(...hits.map((hit) => hit.id));
				return undefined;
			},
		});
		await new MemoryMcpResource().mcpRecall({ q: 'heron' }, { user: aliceUser });
		assert.deepEqual(given, [kept.id]);
	});
});
