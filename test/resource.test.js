import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import {
	MEMORY_RESOURCES,
	MemoryActionResource,
	MemoryBootstrapResource,
	MemoryImportResource,
	MemoryItemResource,
	MemoryResource,
} from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };
const parse = async (response) => ({
	status: response.status,
	headers: response.headers,
	body: await response.json(),
});
const queryTarget = (query = '', params = {}) => Object.assign(new URLSearchParams(query), params);

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('MEMORY_RESOURCES static surface', () => {
	it('declares static path, static hidden = true, and static REST verbs without loadAsInstance or instance verbs', () => {
		assert.deepEqual(
			MEMORY_RESOURCES.map((ResourceClass) => ResourceClass.path),
			['/Memory/*rest', '/Memory/bootstrap', '/Memory/import', '/Memory/:id', '/Memory/:id/:action'],
		);
		for (const ResourceClass of MEMORY_RESOURCES) {
			assert.equal(ResourceClass.hidden, true);
			assert.equal(Object.hasOwn(ResourceClass, 'loadAsInstance'), false);
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'get'), false);
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'post'), false);
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'put'), false);
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'delete'), false);
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'segments'), false);
		}
	});

	it('routes put (create/revise), get (with ETag), delete (withdraw), search, bootstrap, pin, unpin, confirm, and import via static verbs, and rejects removed POST routes with 404/405', async () => {
		const context = { user: superUser };
		const id = 'mem-item-00000001';
		const created = await parse(
			await MemoryItemResource.put(queryTarget('', { id }), { title: 't1', content: 'alpha content' }, context),
		);
		assert.equal(created.status, 201);
		assert.deepEqual(created.body, { id, revision: 1, candidates: [] });

		const fetched = await parse(await MemoryItemResource.get(queryTarget('', { id }), context));
		assert.equal(fetched.status, 200);
		assert.equal(fetched.headers.get('etag'), '"1"');
		assert.equal(fetched.body.memory.id, id);

		const searched = await parse(await MemoryResource.get(queryTarget('q=alpha', { rest: '' }), context));
		assert.equal(searched.status, 200);
		assert.deepEqual(
			searched.body.memories.map((m) => m.id),
			[id],
		);

		const pinned = await parse(await MemoryActionResource.post(queryTarget('', { id, action: 'pin' }), {}, context));
		assert.equal(pinned.status, 200);
		assert.equal(pinned.body.pinned, true);
		assert.equal(pinned.body.memoryId, id);

		const boot = await parse(await MemoryBootstrapResource.get(queryTarget('budget=8000'), context));
		assert.equal(boot.status, 200);
		assert.deepEqual(
			boot.body.memories.map((m) => [m.id, m.section]),
			[[id, 'pinned']],
		);

		const unpinned = await parse(
			await MemoryActionResource.post(queryTarget('', { id, action: 'unpin' }), {}, context),
		);
		assert.equal(unpinned.status, 200);
		assert.equal(unpinned.body.pinned, false);

		const revised = await parse(
			await MemoryItemResource.put(
				queryTarget('', { id }),
				{ content: 'updated alpha content', visibility: 'shared' },
				{ ...context, headers: { 'if-match': '"1"' } },
			),
		);
		assert.equal(revised.status, 200);
		assert.deepEqual(revised.body, { id, revision: 2, candidates: [] });

		const afterRevise = await parse(await MemoryItemResource.get(queryTarget('', { id }), context));
		assert.equal(afterRevise.headers.get('etag'), '"2"');
		assert.deepEqual(afterRevise.body.memory.scopes, ['global']);

		const confirmed = await parse(
			await MemoryActionResource.post(queryTarget('', { id, action: 'confirm' }), {}, context),
		);
		assert.equal(confirmed.status, 200);
		assert.equal(confirmed.body.memory.revision, 3);
		assert.equal(confirmed.body.memory.confirmed.by, 'root');

		const withdrawn = await parse(
			await MemoryItemResource.delete(queryTarget('reason=done', { id }), {
				...context,
				headers: { 'if-match': '"3"' },
			}),
		);
		assert.equal(withdrawn.status, 200);
		assert.equal(withdrawn.body.memory.status, 'withdrawn');
		assert.equal(withdrawn.body.memory.withdrawnReason, 'done');

		const imported = await parse(
			await MemoryImportResource.post(
				queryTarget(''),
				{
					rows: [
						{
							id: 'imported-row-0001',
							ownerId: 'root',
							content: 'imported',
							scopes: ['global'],
							status: 'active',
						},
					],
				},
				context,
			),
		);
		assert.equal(imported.status, 200);
		assert.equal(imported.body.results[0].result, 'created');

		// Unsupported POST routes must return 404/405.
		assert.equal((await parse(await MemoryResource.post(queryTarget('', { rest: '' }), {}, context))).status, 405);
		for (const removedAction of ['revise', 'scopes', 'withdraw', 'explode']) {
			assert.equal(
				(await parse(await MemoryActionResource.post(queryTarget('', { id, action: removedAction }), {}, context)))
					.status,
				404,
				removedAction,
			);
		}
		assert.equal((await parse(await MemoryResource.get(queryTarget('', { rest: 'extra' }), context))).status, 404);
		assert.equal(
			(await parse(await MemoryBootstrapResource.get(queryTarget('', { pathname: 'extra' }), context))).status,
			404,
		);
		assert.equal(
			(await parse(await MemoryImportResource.post(queryTarget('', { pathname: 'extra' }), {}, context))).status,
			404,
		);
	});

	it('consumes the HTTP entry context.authorize flag so internal table reads do not inherit Resource authorization', async () => {
		const context = { user: { username: 'alice' }, authorize: true };
		const searched = await parse(await MemoryResource.get(queryTarget('', { rest: '' }), context));
		assert.equal(searched.status, 200);
		assert.equal(context.authorize, false);
	});
});

describe('MemoryResource errors', () => {
	it('answers an unauthenticated request with 401', async () => {
		const res = await parse(await MemoryResource.get(queryTarget('', { rest: '' }), {}));
		assert.equal(res.status, 401);
		assert.deepEqual(res.body, { error: 'Authenticated principal required', code: 'principal_required' });
	});

	it('turns a record lock that was not granted in time into a retryable 503', async () => {
		const Memory = databases.memory.Memory;
		const lock = Memory.lock;
		Memory.lock = async () => {
			throw Object.assign(new Error('lock wait for row abc timed out'), { statusCode: 423 });
		};
		try {
			const res = await parse(
				await MemoryItemResource.put(
					queryTarget('', { id: 'mem-lock-timeout1' }),
					{ title: 't', content: 'c' },
					{ user: superUser },
				),
			);
			assert.equal(res.status, 503);
			assert.deepEqual(res.body, { error: 'Temporarily unavailable; retry shortly', code: 'unavailable' });
		} finally {
			Memory.lock = lock;
		}
	});

	it('treats a lapsed lock lease and transient embedding backend failures as retryable 503, and other 409/embed errors as 500', async () => {
		const Memory = databases.memory.Memory;
		const put = Memory.put;
		const create = async (id) =>
			parse(await MemoryItemResource.put(queryTarget('', { id }), { title: 't', content: 'c' }, { user: superUser }));
		try {
			Memory.put = async () => {
				throw Object.assign(new Error('Record lock lease expired'), { statusCode: 409 });
			};
			assert.equal((await create('mem-lease-lapsed1')).status, 503);
			Memory.put = async () => {
				throw new Error(
					'Failed to compute embedding for attribute "embedding" [Error] (backend HTTP 429) — see server log for details',
				);
			};
			assert.equal((await create('mem-embed-429-id1')).status, 503);
			Memory.put = async () => {
				throw new Error(
					'Failed to compute embedding for attribute "embedding" [TimeoutError] — see server log for details',
				);
			};
			assert.equal((await create('mem-embed-time-id')).status, 503);
			Memory.put = async () => {
				throw new Error(
					'Failed to compute embedding for attribute "embedding" [TypeError] — see server log for details',
				);
			};
			assert.equal((await create('mem-embed-conn-id')).status, 503);
			Memory.put = async () => {
				throw new Error(
					'Failed to compute embedding for attribute "embedding" [Error] (backend HTTP 400) — see server log for details',
				);
			};
			assert.equal((await create('mem-embed-400-id1')).status, 500);
			Memory.put = async () => {
				throw Object.assign(new Error('Record already exists'), { statusCode: 409 });
			};
			const defect = await create('mem-other-409-id1');
			assert.equal(defect.status, 500);
			assert.deepEqual(defect.body, { error: 'Internal error', code: 'internal_error' });
		} finally {
			Memory.put = put;
		}
	});

	it('answers a rejected request body promise with 400 invalid_body', async () => {
		const res = await parse(
			await MemoryItemResource.put(
				queryTarget('', { id: 'mem-bad-json-body' }),
				Promise.reject(new SyntaxError('Unexpected token')),
				{ user: superUser },
			),
		);
		assert.equal(res.status, 400);
		assert.deepEqual(res.body, { error: 'Request body must be valid JSON', code: 'invalid_body' });
	});

	it('hides the text of any other unexpected error behind a 500', async () => {
		const Memory = databases.memory.Memory;
		const get = Memory.get;
		Memory.get = async () => {
			throw new Error('disk path /secret/db failed');
		};
		try {
			const res = await parse(
				await MemoryItemResource.get(queryTarget('', { id: 'a'.repeat(32) }), { user: superUser }),
			);
			assert.equal(res.status, 500);
			assert.deepEqual(res.body, { error: 'Internal error', code: 'internal_error' });
		} finally {
			Memory.get = get;
		}
	});
});
