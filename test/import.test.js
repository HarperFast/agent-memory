import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { __test, models } from 'harper';
import { importMemories } from '../dist/import.js';
import { getMemory, putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { registerMemorySink } from '../dist/sinks.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const root = createPrincipal({ id: 'root', superUser: true });
const alice = createPrincipal({ id: 'alice' });
const context = {};
const rows = () => __test.stores.get('Memory');

const idOf = (sourceId) => createHash('sha256').update(`flair:${sourceId}`).digest('hex').slice(0, 32);

const row = (sourceId, overrides = {}) => ({
	id: idOf(sourceId),
	ownerId: 'alice',
	content: `imported ${sourceId}`,
	scopes: ['user:alice'],
	status: 'active',
	createdAt: '2025-01-02T03:04:05.000Z',
	...overrides,
});

async function rejection(promise, statusCode, code, index) {
	const error = await promise.then(
		() => null,
		(reason) => reason,
	);
	assert.ok(error, 'expected a rejection');
	assert.equal(error.statusCode, statusCode, error.message);
	assert.equal(error.code, code);
	assert.equal(error.index, index);
}

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('importMemories', () => {
	it('is super_user only', async () => {
		await rejection(importMemories({ rows: [row(1)] }, alice, context), 403, 'import_forbidden', undefined);
	});

	it('embeds the rows it will create in one call, before taking any lock', async () => {
		await importMemories({ rows: [row(1)] }, root, context);
		const embed = models.embed;
		const calls = [];
		models.embed = (input, options) => {
			calls.push({ input, locks: __test.lockLog.length });
			return embed.call(models, input, options);
		};
		__test.lockLog.length = 0;
		try {
			await importMemories({ rows: [row(1), row(2), row(3)] }, root, context);
		} finally {
			models.embed = embed;
		}
		assert.deepEqual(calls, [{ input: ['imported 2', 'imported 3'], locks: 0 }]);
		assert.deepEqual(rows().get(idOf(2)).embedding, Array.from(Float32Array.from(__test.embedText('imported 2'))));
	});

	it('splits the embedding of a large batch into requests of bounded size', async () => {
		applySettings(parseSettings({ limits: { contentChars: 60_000, embeddingInputChars: 60_000 } }));
		const big = (n) => row(`big-${n}`, { content: `${n} `.repeat(30_000) });
		const embed = models.embed;
		const sizes = [];
		models.embed = (input, options) => {
			sizes.push(input.length);
			return embed.call(models, input, options);
		};
		try {
			await importMemories({ rows: [big(1), big(2), big(3), big(4)] }, root, context);
		} finally {
			models.embed = embed;
		}
		assert.deepEqual(sizes, [1, 1, 1, 1]);
	});

	it('sizes those requests by the bounded embedding input, not the stored content', async () => {
		applySettings(parseSettings({ limits: { contentChars: 60_000, embeddingInputChars: 40_000 } }));
		const big = (n) => row(`big-${n}`, { content: `${n} `.repeat(30_000) });
		const embed = models.embed;
		const sizes = [];
		models.embed = (input, options) => {
			sizes.push(input.map((text) => text.length));
			return embed.call(models, input, options);
		};
		try {
			await importMemories({ rows: [big(1), big(2), big(3), big(4)] }, root, context);
		} finally {
			models.embed = embed;
		}
		assert.deepEqual(sizes, [
			[40_000, 40_000],
			[40_000, 40_000],
		]);
		assert.equal(rows().get(idOf('big-1')).content.length, 59_999);
	});

	it('bounds and sizes the whole batch under the settings it started with', async () => {
		applySettings(parseSettings({ limits: { contentChars: 60_000, embeddingInputChars: 40_000 } }));
		const big = (n) => row(`big-${n}`, { content: `${n} `.repeat(30_000) });
		const embed = models.embed;
		const sizes = [];
		models.embed = (input, options) => {
			sizes.push(input.map((text) => text.length));
			applySettings(parseSettings({ limits: { contentChars: 60_000, embeddingInputChars: 100_000 } }));
			return embed.call(models, input, options);
		};
		try {
			await importMemories({ rows: [big(1), big(2), big(3), big(4)] }, root, context);
		} finally {
			models.embed = embed;
		}
		assert.deepEqual(sizes, [
			[40_000, 40_000],
			[40_000, 40_000],
		]);
	});

	it('preserves owner, createdAt, typed evidence and links, with status derived from the graph (successor first)', async () => {
		const evidence = [
			{ kind: 'memory', ref: idOf(1), note: 'imported predecessor' },
			{ kind: 'doc', ref: 'flair:note:2' },
		];
		const result = await importMemories(
			{
				rows: [
					row(2, { supersedes: [idOf(1)], scopes: ['global'], evidence }),
					row(1, { status: 'superseded', supersededBy: idOf(2) }),
				],
			},
			root,
			context,
		);
		assert.deepEqual(result.results, [
			{ id: idOf(2), result: 'created' },
			{ id: idOf(1), result: 'created' },
		]);
		const successor = await getMemory(idOf(2), alice);
		assert.deepEqual(successor.evidence, evidence);
		assert.deepEqual(successor.evidenceMemoryIds, [idOf(1)]);
		const old = await getMemory(idOf(1), alice);
		assert.equal(old.status, 'superseded');
		assert.equal(old.supersededBy, idOf(2));
		assert.equal(old.createdAt, '2025-01-02T03:04:05.000Z');
		assert.equal(old.title, null);
		assert.equal(old.author.source, 'import');
		assert.equal(old.revision, 1);
	});

	it('never publishes a memory hidden behind a withdrawn replacement', async () => {
		await importMemories({ rows: [row(2, { supersedes: [idOf(1)] })] }, root, context);
		await withdrawMemory(idOf(2), {}, alice, { headers: { 'if-match': '"1"' } });
		const replay = await importMemories(
			{ rows: [row(2, { supersedes: [idOf(1)] }), row(1, { status: 'superseded', supersededBy: idOf(2) })] },
			root,
			context,
		);
		assert.deepEqual(
			replay.results.map((result) => result.result),
			['unchanged', 'created'],
		);
		const restored = await getMemory(idOf(1), alice);
		assert.equal(restored.status, 'active');
		assert.equal(restored.supersededBy, null);
	});

	it('marks an already stored row superseded when its replacement arrives later', async () => {
		await importMemories({ rows: [row(1, { status: 'superseded', supersededBy: idOf(2) })] }, root, context);
		assert.equal((await getMemory(idOf(1), alice)).status, 'active', 'no replacement exists yet');
		await importMemories({ rows: [row(2, { supersedes: [idOf(1)] })] }, root, context);
		const superseded = await getMemory(idOf(1), alice);
		assert.equal(superseded.status, 'superseded');
		assert.equal(superseded.supersededBy, idOf(2));
		assert.equal(superseded.revision, 2);
	});

	it('keeps the newest superseder as the pointer when a later native create supersedes the same memory', async () => {
		await importMemories(
			{ rows: [row(2, { supersedes: [idOf(1)], createdAt: '2099-01-01T00:00:00.000Z' }), row(1)] },
			root,
			context,
		);
		await putMemory(
			idOf('native'),
			{ title: 'n', content: 'native replacement', supersedes: [idOf(1)] },
			alice,
			context,
		);
		assert.equal((await getMemory(idOf(1), alice)).supersededBy, idOf(2));
	});

	it('re-runs idempotently and reports a changed row as a conflict without overwriting it', async () => {
		await importMemories({ rows: [row(1)] }, root, context);
		assert.deepEqual((await importMemories({ rows: [row(1)] }, root, context)).results, [
			{ id: idOf(1), result: 'unchanged' },
		]);
		assert.deepEqual((await importMemories({ rows: [row(1, { content: 'changed' })] }, root, context)).results, [
			{ id: idOf(1), result: 'conflict' },
		]);
		assert.deepEqual((await importMemories({ rows: [row(1, { ownerId: 'bob' })] }, root, context)).results, [
			{ id: idOf(1), result: 'conflict' },
		]);
		assert.equal(rows().get(idOf(1)).content, 'imported 1');
	});

	it('rejects the whole batch, naming the row, when any row is invalid', async () => {
		const cases = [
			[row(2, { id: 'short' }), 'invalid_id'],
			[row(2, { id: undefined }), 'invalid_id'],
			[row(2, { idempotencyKey: 'import:flair:2' }), 'unsupported_fields'],
			[row(2, { ownerId: 'has space' }), 'invalid_principal_id'],
			[row(2, { ownerId: undefined }), 'ownerId_required'],
			[row(2, { scopes: ['customer:*'] }), 'invalid_scopes'],
			[row(2, { status: 'superseded' }), 'invalid_supersededBy'],
			[row(2, { supersededBy: idOf(1) }), 'invalid_supersededBy'],
			[row(2, { supersedes: [idOf(2)] }), 'self_supersede'],
			[row(2, { withdrawnReason: 'x' }), 'invalid_status'],
			[row(2, { visibility: 'shared' }), 'unsupported_fields'],
			[row(2, { durability: 'permanent' }), 'unsupported_fields'],
			[row(2, { pinned: true }), 'unsupported_fields'],
			[row(2, { evidenceMemoryIds: [idOf(1)] }), 'unsupported_fields'],
			[row(2, { evidence: ['legacy-string'] }), 'invalid_evidence'],
			[row(2, { evidence: [{ kind: 'memory', ref: 'short' }] }), 'invalid_evidence'],
			[row(2, { content: undefined }), 'content_required'],
		];
		for (const [bad, code] of cases) {
			await rejection(importMemories({ rows: [row(1), bad] }, root, context), 400, code, 1);
		}
		await rejection(importMemories({ rows: [row(1), row(1)] }, root, context), 400, 'duplicate_row', 1);
		await rejection(importMemories({ rows: [] }, root, context), 400, 'invalid_rows', undefined);
		await rejection(
			importMemories({ rows: Array.from({ length: 101 }, (_, i) => row(i)) }, root, context),
			400,
			'too_many_rows',
			undefined,
		);
		assert.equal(rows().size, 0);
	});

	it('hands withdrawn rows to sinks as withdrawals and rolls the batch back if a sink throws', async () => {
		const calls = [];
		let fail = false;
		const unregister = registerMemorySink({
			write: (memory) => {
				if (fail) throw new Error('sink down');
				calls.push(['write', memory.id]);
			},
			withdraw: (memory) => calls.push(['withdraw', memory.id]),
		});
		try {
			await importMemories({ rows: [row(1), row(2, { status: 'withdrawn', withdrawnReason: 'gone' })] }, root, context);
			assert.deepEqual(calls, [
				['write', idOf(1)],
				['withdraw', idOf(2)],
			]);
			fail = true;
			await assert.rejects(importMemories({ rows: [row(3), row(4)] }, root, context), /sink down/);
			assert.equal(rows().has(idOf(3)), false);
		} finally {
			unregister();
		}
	});

	describe('carried review and quarantine state', () => {
		const flag = { kind: 'possible-customer-detail', since: '2025-03-01T00:00:00.000Z', source: 'model' };
		const review = {
			since: '2025-04-01T00:00:00.000Z',
			cause: 'superseded',
			sourceId: idOf(9),
			replacementId: idOf(8),
		};

		it('stores a carried contentFlag and needsReview on a created row, with their indexed mirrors', async () => {
			await importMemories(
				{
					rows: [
						row(1, { scopes: ['global'], contentFlag: { ...flag, labels: ['customer:x', 'zorb-host'] } }),
						row(2, { needsReview: review }),
						row(3, { contentFlag: null, needsReview: null }),
					],
				},
				root,
				context,
			);
			const flagged = rows().get(idOf(1));
			assert.deepEqual(flagged.contentFlag, { ...flag, labels: ['customer:x', 'zorb-host'] });
			assert.equal(flagged.contentFlagged, true);
			const reviewed = rows().get(idOf(2));
			assert.deepEqual(reviewed.needsReview, review);
			assert.equal(reviewed.needsReviewSince.toISOString(), review.since);
			const plain = rows().get(idOf(3));
			assert.equal(plain.contentFlag, null);
			assert.equal(plain.needsReview, null);
		});

		it('keeps a carried flag where the target check would not flag, and a carried review over a batch transition', async () => {
			applySettings(parseSettings({ customerContentCheck: { mode: 'off' } }));
			await importMemories(
				{
					rows: [
						row(5, { scopes: ['global'] }),
						row(6, { scopes: ['global'], evidence: [{ kind: 'memory', ref: idOf(5) }] }),
					],
				},
				root,
				context,
			);
			await importMemories(
				{
					rows: [
						row(1, { scopes: ['global'], contentFlag: flag }),
						row(7, { scopes: ['global'], supersedes: [idOf(5)] }),
						row(8, { scopes: ['global'], evidence: [{ kind: 'memory', ref: idOf(5) }], needsReview: review }),
					],
				},
				root,
				context,
			);
			assert.deepEqual(rows().get(idOf(1)).contentFlag, flag);
			assert.equal(rows().get(idOf(6)).needsReview.sourceId, idOf(5), 'a stored citer is still flagged');
			assert.deepEqual(rows().get(idOf(8)).needsReview, review);
		});

		it('leaves an existing row alone and keeps carried state out of the unchanged comparison', async () => {
			await importMemories({ rows: [row(1, { scopes: ['global'] })] }, root, context);
			const { results } = await importMemories(
				{ rows: [row(1, { scopes: ['global'], contentFlag: flag, needsReview: review })] },
				root,
				context,
			);
			assert.deepEqual(results, [{ id: idOf(1), result: 'unchanged' }]);
			assert.equal(rows().get(idOf(1)).contentFlag, null);
			assert.equal(rows().get(idOf(1)).needsReview, null);
		});

		it('rejects malformed carried state with the row index, before writing anything', async () => {
			const bad = [
				[{ contentFlag: flag }, 'invalid_contentFlag'],
				[{ scopes: ['global'], contentFlag: { ...flag, kind: 'other' } }, 'invalid_contentFlag'],
				[{ scopes: ['global'], contentFlag: { ...flag, source: 'judge' } }, 'invalid_contentFlag'],
				[{ scopes: ['global'], contentFlag: { ...flag, since: 'soon' } }, 'invalid_contentFlag'],
				[{ scopes: ['global'], contentFlag: { ...flag, labels: ['not a label'] } }, 'invalid_contentFlag'],
				[{ scopes: ['global'], contentFlag: { ...flag, extra: 1 } }, 'invalid_contentFlag'],
				[{ needsReview: { ...review, cause: 'revised' } }, 'invalid_needsReview'],
				[{ needsReview: { ...review, sourceId: 'short' } }, 'invalid_needsReview'],
				[{ needsReview: { ...review, replacementId: 7 } }, 'invalid_needsReview'],
				[{ needsReview: 'yes' }, 'invalid_needsReview'],
			];
			for (const [overrides, code] of bad) {
				await rejection(importMemories({ rows: [row(1), row(2, overrides)] }, root, context), 400, code, 1);
			}
			assert.equal(rows().size, 0);
		});
	});
});
