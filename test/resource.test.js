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
const parse = async (response) => ({ status: response.status, body: await response.json() });
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
			assert.equal(Object.hasOwn(ResourceClass.prototype, 'segments'), false);
		}
	});

	it('routes create, get, search, bootstrap, revise, scopes, pin, unpin, withdraw, and import via static verbs', async () => {
		const context = { user: superUser };
		const created = await parse(
			await MemoryResource.post(
				queryTarget('', { rest: '' }),
				{ idempotencyKey: 'k1', title: 't1', content: 'alpha content' },
				context,
			),
		);
		assert.equal(created.status, 201);
		const id = created.body.memory.id;

		const fetched = await parse(await MemoryItemResource.get(queryTarget('', { id }), context));
		assert.equal(fetched.status, 200);
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
			await MemoryActionResource.post(
				queryTarget('', { id, action: 'revise' }),
				{ expectedRevision: 1, content: 'updated alpha content' },
				context,
			),
		);
		assert.equal(revised.status, 200);
		assert.equal(revised.body.memory.revision, 2);

		const rescoped = await parse(
			await MemoryActionResource.post(
				queryTarget('', { id, action: 'scopes' }),
				{ expectedRevision: 2, visibility: 'shared' },
				context,
			),
		);
		assert.equal(rescoped.status, 200);
		assert.deepEqual(rescoped.body.memory.scopes, ['global']);

		const withdrawn = await parse(
			await MemoryActionResource.post(
				queryTarget('', { id, action: 'withdraw' }),
				{ expectedRevision: 3, reason: 'done' },
				context,
			),
		);
		assert.equal(withdrawn.status, 200);
		assert.equal(withdrawn.body.memory.status, 'withdrawn');

		const imported = await parse(
			await MemoryImportResource.post(
				queryTarget(''),
				{
					rows: [
						{
							idempotencyKey: 'import:flair:1',
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

		assert.equal((await parse(await MemoryResource.get(queryTarget('', { rest: 'extra' }), context))).status, 404);
		assert.equal(
			(await parse(await MemoryActionResource.post(queryTarget('', { id, action: 'explode' }), {}, context))).status,
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
		assert.deepEqual(await parse(await MemoryResource.get(queryTarget('', { rest: '' }), {})), {
			status: 401,
			body: { error: 'Authenticated principal required', code: 'principal_required' },
		});
	});

	it('turns a record lock that was not granted in time into a retryable 503', async () => {
		const Memory = databases.memory.Memory;
		const lock = Memory.lock;
		Memory.lock = async () => {
			throw Object.assign(new Error('lock wait for row abc timed out'), { statusCode: 423 });
		};
		try {
			assert.deepEqual(
				await parse(
					await MemoryResource.post(
						queryTarget('', { rest: '' }),
						{ idempotencyKey: 'k', title: 't', content: 'c' },
						{ user: superUser },
					),
				),
				{
					status: 503,
					body: { error: 'Temporarily unavailable; retry shortly', code: 'unavailable' },
				},
			);
		} finally {
			Memory.lock = lock;
		}
	});

	it('treats a lapsed lock lease as retryable but any other 409 as a defect', async () => {
		const Memory = databases.memory.Memory;
		const put = Memory.put;
		const create = async (key) =>
			parse(
				await MemoryResource.post(
					queryTarget('', { rest: '' }),
					{ idempotencyKey: key, title: 't', content: 'c' },
					{ user: superUser },
				),
			);
		try {
			Memory.put = async () => {
				throw Object.assign(new Error('Record lock lease expired'), { statusCode: 409 });
			};
			assert.equal((await create('a')).status, 503);
			Memory.put = async () => {
				throw Object.assign(new Error('Record already exists'), { statusCode: 409 });
			};
			assert.deepEqual(await create('b'), { status: 500, body: { error: 'Internal error', code: 'internal_error' } });
		} finally {
			Memory.put = put;
		}
	});

	it('answers a rejected request body promise with 400 invalid_body', async () => {
		assert.deepEqual(
			await parse(
				await MemoryResource.post(queryTarget('', { rest: '' }), Promise.reject(new SyntaxError('Unexpected token')), {
					user: superUser,
				}),
			),
			{
				status: 400,
				body: { error: 'Request body must be valid JSON', code: 'invalid_body' },
			},
		);
	});

	it('hides the text of any other unexpected error behind a 500', async () => {
		const Memory = databases.memory.Memory;
		const get = Memory.get;
		Memory.get = async () => {
			throw new Error('disk path /secret/db failed');
		};
		try {
			assert.deepEqual(
				await parse(await MemoryItemResource.get(queryTarget('', { id: 'a'.repeat(32) }), { user: superUser })),
				{
					status: 500,
					body: { error: 'Internal error', code: 'internal_error' },
				},
			);
		} finally {
			Memory.get = get;
		}
	});
});
