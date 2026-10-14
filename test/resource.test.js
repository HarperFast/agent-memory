import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import { MemoryResource } from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };
const request = async (user, method, pathname, body) => {
	const resource = new MemoryResource({ user });
	const target = Object.assign(new URLSearchParams(), { pathname });
	const response = method === 'GET' ? await resource.get(target) : await resource.post(target, body);
	return { status: response.status, body: await response.json() };
};

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
});

describe('MemoryResource errors', () => {
	it('answers an unauthenticated request with 401', async () => {
		assert.deepEqual(await request(undefined, 'GET', '/'), {
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
			assert.deepEqual(await request(superUser, 'POST', '/', { idempotencyKey: 'k', title: 't', content: 'c' }), {
				status: 503,
				body: { error: 'Temporarily unavailable; retry shortly', code: 'unavailable' },
			});
		} finally {
			Memory.lock = lock;
		}
	});

	it('hides the text of any other unexpected error behind a 500', async () => {
		const Memory = databases.memory.Memory;
		const get = Memory.get;
		Memory.get = async () => {
			throw new Error('disk path /secret/db failed');
		};
		try {
			assert.deepEqual(await request(superUser, 'GET', `/${'a'.repeat(32)}`), {
				status: 500,
				body: { error: 'Internal error', code: 'internal_error' },
			});
		} finally {
			Memory.get = get;
		}
	});
});
