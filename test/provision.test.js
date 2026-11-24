import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from 'harper';
import {
	MAX_DELEGATES,
	ProvisionError,
	RESERVATION_TTL_MS,
	authorizeCaller,
	generatePassword,
	handleProvisionRequest,
} from '../deploy/engineering/provision.js';

const PROVISIONER = { username: 'dispatch-provisioner', role: { role: 'provisioner', permission: {} } };
const NOW = Date.UTC(2026, 10, 24);

// Commits a withNameLock callback only when it resolves, as the Harper transaction does. Grant rows are keyed by
// username. `hooks` run just before the matching store call, to model a concurrent writer.
function fakeStore({ users = {}, records = {}, grants = {} } = {}) {
	const state = {
		users: new Map(Object.entries(users).map(([name, user]) => [name, { active: true, ...user }])),
		records: new Map(Object.entries(records).map(([name, row]) => [name, { username: name, ...row }])),
		grants: new Map(Object.entries(grants)),
		passwords: new Map(),
		hooks: {},
		calls: [],
	};
	const store = {
		now: () => new Date(NOW),
		async getUser(name) {
			const user = state.users.get(name);
			return user && { role: user.role, active: user.active };
		},
		async authenticate(name, password) {
			await state.hooks.authenticate?.(name);
			const user = state.users.get(name);
			if (!user?.active || state.passwords.get(name) !== password) return undefined;
			return { role: user.role, active: true };
		},
		async addUser(name, password, role) {
			state.calls.push(['addUser', name, role]);
			await state.hooks.addUser?.(name);
			if (state.users.has(name)) throw new ProvisionError(409, 'user_exists', 'User already exists');
			state.users.set(name, { role, active: true });
			state.passwords.set(name, password);
		},
		async setPassword(name, password) {
			state.calls.push(['setPassword', name]);
			await state.hooks.setPassword?.(name);
			state.passwords.set(name, password);
		},
		async getRecord(name) {
			return state.records.get(name);
		},
		async getGrantRow(name) {
			return state.grants.get(name);
		},
		async *delegatesOf(principal, limit) {
			let count = 0;
			for (const row of state.records.values()) {
				if (row.principal === principal && count++ < limit) yield row;
			}
		},
		async hasInboundDelegation(name) {
			return [...state.grants.values()].some((row) => row.actsFor === name);
		},
		async withNameLock(names, fn) {
			await state.hooks.lock?.(names);
			const records = new Map(state.records);
			const grants = new Map(state.grants);
			const result = await fn({
				getRecord: async (id) => records.get(id),
				putRecord: async (row) => records.set(row.username, { ...row }),
				deleteRecord: async (id) => records.delete(id),
				getGrantRow: async (id) => grants.get(id),
				putGrantRow: async ({ username, ...row }) => grants.set(username, row),
				deleteGrantRow: async (id) => grants.delete(id),
			});
			state.records = records;
			state.grants = grants;
			return result;
		},
	};
	return { store, state };
}

async function call(store, { method = 'POST', path = '/', body, user = PROVISIONER } = {}) {
	const response = await handleProvisionRequest(
		method,
		{ pathname: path },
		body instanceof Promise ? body : Promise.resolve(body),
		user,
		() => store,
	);
	return { status: response.status, headers: response.headers, body: await response.json() };
}

const managed = (principal, extra = {}) => ({
	principal,
	machine: null,
	createdAt: new Date(NOW - 86_400_000),
	...extra,
});

describe('authorizeCaller', () => {
	it('admits the provisioner role and super_user only', () => {
		assert.equal(authorizeCaller(PROVISIONER), 'dispatch-provisioner');
		assert.equal(
			authorizeCaller({ username: 'root', role: { role: 'admin', permission: { super_user: true } } }),
			'root',
		);
		for (const role of ['eng', 'eng-agents', 'eng-public', 'dispatch-worker', 'provisioner-x', undefined]) {
			assert.throws(
				() => authorizeCaller({ username: 'someone', role: { role, permission: {} } }),
				(error) => error.statusCode === 403 && error.code === 'provisioner_required',
			);
		}
		assert.throws(
			() => authorizeCaller(undefined),
			(error) => error.statusCode === 401,
		);
		assert.throws(
			() => authorizeCaller({ role: { role: 'provisioner' } }),
			(error) => error.statusCode === 401,
		);
	});
});

describe('generatePassword', () => {
	it('returns 40 URL-safe characters, different each time', () => {
		const passwords = new Set(Array.from({ length: 50 }, generatePassword));
		assert.equal(passwords.size, 50);
		for (const password of passwords) assert.match(password, /^[A-Za-z0-9_-]{40}$/);
	});
});

describe('handleProvisionRequest routing', () => {
	it('refuses anyone but the provisioner before reading anything', async () => {
		const { store, state } = fakeStore({ users: { 'kris@example.com': { role: 'eng' } } });
		const eng = { username: 'kris@example.com', role: { role: 'eng', permission: {} } };
		for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
			assert.equal((await call(store, { method, path: '/kris@example.com', user: null })).status, 401);
			const refused = await call(store, {
				method,
				body: { action: 'create', principal: 'a@example.com', role: 'eng' },
				user: eng,
			});
			assert.equal(refused.status, 403);
			assert.equal(refused.body.code, 'provisioner_required');
		}
		assert.deepEqual(state.calls, []);
	});

	it('opens no store and leaves no unhandled rejection for a refused request', async () => {
		const refusedStore = () => {
			throw new Error('the store was opened for an unauthorized caller');
		};
		for (const method of ['POST', 'PUT', 'PATCH']) {
			const response = await handleProvisionRequest(
				method,
				{ pathname: '/' },
				Promise.reject(new SyntaxError('bad json')),
				null,
				refusedStore,
			);
			assert.equal(response.status, 401);
		}
		const { store } = fakeStore();
		const misdirected = await call(store, { path: '/a@example.com', body: Promise.reject(new SyntaxError('bad')) });
		assert.equal(misdirected.status, 404);
		await new Promise((resolve) => setImmediate(resolve));
	});

	it('decodes the principal from the path and refuses bad encoding', async () => {
		const { store } = fakeStore({ users: { 'kris@example.com': { role: 'eng' } } });
		const found = await call(store, { method: 'GET', path: '/kris%40example.com' });
		assert.equal(found.status, 200);
		assert.equal(found.body.exists, true);
		assert.equal((await call(store, { method: 'GET', path: '/%E0%A4%A' })).status, 400);
	});

	it('answers 405 to other methods and 404 to a POST with a path', async () => {
		const { store } = fakeStore();
		for (const method of ['PUT', 'PATCH', 'DELETE', 'CONNECT']) {
			const response = await call(store, { method, path: '/a@example.com' });
			assert.equal(response.status, 405);
		}
		const posted = await call(store, { path: '/a@example.com', body: { action: 'rotate', username: 'a@example.com' } });
		assert.equal(posted.status, 404);
	});

	it('refuses a body that is not a JSON object, an unknown action and an unknown field', async () => {
		const { store } = fakeStore();
		const cases = [
			[Promise.reject(new SyntaxError('bad json')), 'invalid_body'],
			[['create'], 'invalid_body'],
			[null, 'invalid_body'],
			[{ action: 'delete', username: 'a@example.com' }, 'invalid_action'],
			[{ action: 'constructor' }, 'invalid_action'],
			[{ action: 'create', principal: 'a@example.com', role: 'eng', active: false }, 'unknown_field'],
			[{ action: 'rotate', username: 'a@example.com', role: 'super_user' }, 'unknown_field'],
		];
		for (const [body, code] of cases) {
			const response = await call(store, { body });
			assert.equal(response.status, 400, code);
			assert.equal(response.body.code, code);
		}
	});
});

describe('create', () => {
	it('creates the user with a fresh password and records it as managed', async () => {
		const { store, state } = fakeStore();
		const response = await call(store, {
			body: { action: 'create', principal: 'kris@example.com', role: 'eng-public' },
		});
		assert.equal(response.status, 201);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(response.body.username, 'kris@example.com');
		assert.match(response.body.password, /^[A-Za-z0-9_-]{40}$/);
		assert.equal(state.passwords.get('kris@example.com'), response.body.password);
		assert.deepEqual(state.users.get('kris@example.com'), { role: 'eng-public', active: true });
		assert.deepEqual(state.records.get('kris@example.com'), {
			username: 'kris@example.com',
			principal: 'kris@example.com',
			machine: null,
			createdAt: new Date(NOW),
			createdBy: 'dispatch-provisioner',
		});
		assert.equal(state.grants.size, 0);
	});

	it('assigns only eng and eng-public, and writes nothing otherwise', async () => {
		for (const role of ['super_user', 'provisioner', 'dispatch-worker', 'eng-agents', 'admin', undefined, ['eng']]) {
			const { store, state } = fakeStore();
			const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role } });
			assert.equal(response.status, 403, String(role));
			assert.equal(response.body.code, 'role_not_assignable');
			assert.deepEqual(state.calls, []);
			assert.equal(state.records.size, 0);
		}
	});

	it('takes only a lowercase email of at most 122 characters', async () => {
		const { store, state } = fakeStore();
		const long = `${'a'.repeat(112)}@example.com`;
		for (const principal of [
			'Kris@example.com',
			'kris',
			'kris@example',
			'kris@exa mple.com',
			'k:r@example.com',
			long,
			42,
		]) {
			const response = await call(store, { body: { action: 'create', principal, role: 'eng' } });
			assert.equal(response.status, 400, String(principal));
			assert.equal(response.body.code, 'invalid_principal');
		}
		assert.deepEqual(state.calls, []);
	});

	it('answers 409 for an existing user, including one an admin created', async () => {
		const { store, state } = fakeStore({ users: { 'kris@example.com': { role: 'eng' } } });
		const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role: 'eng' } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_exists');
		assert.equal(state.records.size, 0);
		assert.deepEqual(state.calls, []);
	});

	it('refuses a principal that reads as a delegate of an existing user', async () => {
		const { store } = fakeStore({ users: { 'kris@example.com': { role: 'eng' } } });
		const response = await call(store, {
			body: { action: 'create', principal: 'kris@example.com.laptop', role: 'eng' },
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.code, 'reserved_name');
	});

	it('refuses to inherit a leftover grant row or an inbound delegation, and reuses an empty row', async () => {
		const body = { action: 'create', principal: 'kris@example.com', role: 'eng-public' };
		for (const row of [{ read: ['customer:*'] }, { write: ['global'] }, { actsFor: 'pat@example.com' }]) {
			const { store, state } = fakeStore({ grants: { 'kris@example.com': row } });
			const response = await call(store, { body });
			assert.equal(response.status, 409, JSON.stringify(row));
			assert.equal(response.body.code, 'grant_row_exists');
			assert.deepEqual(state.calls, []);
		}
		const inbound = fakeStore({ grants: { 'kris-agents': { actsFor: 'kris@example.com' } } });
		const refused = await call(inbound.store, { body });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'inbound_delegation');

		const empty = fakeStore({ grants: { 'kris@example.com': { actsFor: null, read: [] } } });
		assert.equal((await call(empty.store, { body })).status, 201);
	});

	it('answers 409 in_progress to a fresh reservation and takes over a stale one', async () => {
		const body = { action: 'create', principal: 'kris@example.com', role: 'eng' };
		const fresh = fakeStore({
			records: { 'kris@example.com': managed('kris@example.com', { createdAt: new Date(NOW - 5_000) }) },
		});
		const busy = await call(fresh.store, { body });
		assert.equal(busy.status, 409);
		assert.equal(busy.body.code, 'in_progress');
		assert.deepEqual(fresh.state.calls, []);

		const staleAt = new Date(NOW - RESERVATION_TTL_MS - 1);
		const stale = fakeStore({ records: { 'kris@example.com': managed('kris@example.com', { createdAt: staleAt }) } });
		const created = await call(stale.store, { body });
		assert.equal(created.status, 201);
		assert.equal(stale.state.records.get('kris@example.com').createdAt.getTime(), NOW);
	});

	it('releases its reservation when an admin creates the name first, leaving the admin user unmanaged', async () => {
		const { store, state } = fakeStore();
		state.hooks.addUser = (name) => state.users.set(name, { role: 'eng', active: true });
		const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role: 'eng' } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_exists');
		assert.equal(state.records.has('kris@example.com'), false);
	});

	it('keeps a reservation it took over when the earlier request creates the user first', async () => {
		const staleAt = new Date(NOW - RESERVATION_TTL_MS - 1);
		const { store, state } = fakeStore({
			records: { 'kris@example.com': managed('kris@example.com', { createdAt: staleAt }) },
		});
		state.hooks.addUser = (name) => state.users.set(name, { role: 'eng', active: true });
		const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role: 'eng' } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_exists');
		assert.equal(state.records.has('kris@example.com'), true);
	});

	it('releases its reservation when add_user fails without creating the user, and keeps it if the user exists', async () => {
		const body = { action: 'create', principal: 'kris@example.com', role: 'eng' };
		const failed = fakeStore();
		failed.state.hooks.addUser = () => {
			throw Object.assign(new Error('disk full'), { statusCode: 500 });
		};
		const response = await call(failed.store, { body });
		assert.equal(response.status, 500);
		assert.equal(response.body.code, 'internal_error');
		assert.match(response.body.ref, /^[0-9a-f]{8}$/);
		assert.equal(failed.state.records.has('kris@example.com'), false);

		const created = fakeStore();
		created.state.hooks.addUser = (name) => {
			created.state.users.set(name, { role: 'eng', active: true });
			throw Object.assign(new Error('reply lost'), { statusCode: 500 });
		};
		assert.equal((await call(created.store, { body })).status, 500);
		assert.equal(created.state.records.has('kris@example.com'), true);
	});

	it('withholds the password, writing nothing more, when the user changes before it is confirmed', async () => {
		const { store, state } = fakeStore();
		state.hooks.authenticate = (name) => (state.users.get(name).role = 'super_user');
		const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role: 'eng' } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_changed');
		assert.equal(response.body.password, undefined);
		assert.deepEqual(
			state.calls.map(([kind]) => kind),
			['addUser'],
		);
	});
});

describe('confirming a new password', () => {
	it('answers 500 at the confirm stage, not user_changed, when authentication itself fails', async () => {
		let logged = '';
		logger.error = (message) => (logged = String(message));
		const { store, state } = fakeStore();
		state.hooks.authenticate = () => {
			throw Object.assign(new Error('backend down'), { statusCode: 500 });
		};
		const response = await call(store, { body: { action: 'create', principal: 'kris@example.com', role: 'eng' } });
		assert.equal(response.status, 500);
		assert.match(logged, /failed at confirm/);
		assert.equal(state.records.has('kris@example.com'), true);
	});
});

describe('addDelegate', () => {
	const principal = 'kris@example.com';
	const owned = (role = 'eng-public', extra = {}) =>
		fakeStore({ users: { [principal]: { role } }, records: { [principal]: managed(principal) }, ...extra });

	it('creates <principal>.<machine> with the principal role, acting for the principal', async () => {
		const { store, state } = owned();
		const response = await call(store, {
			body: { action: 'addDelegate', principal, machine: 'laptop', role: 'eng-public' },
		});
		assert.equal(response.status, 201);
		assert.equal(response.body.username, 'kris@example.com.laptop');
		assert.equal(response.body.actsFor, true);
		assert.equal(state.passwords.get('kris@example.com.laptop'), response.body.password);
		assert.deepEqual(state.users.get('kris@example.com.laptop'), { role: 'eng-public', active: true });
		assert.deepEqual(state.grants.get('kris@example.com.laptop'), { actsFor: principal });
		assert.equal(state.records.get('kris@example.com.laptop').machine, 'laptop');
		assert.equal(state.records.get('kris@example.com.laptop').principal, principal);
	});

	it('makes a delegate of another role a standalone user that does not act for the principal', async () => {
		for (const [principalRole, role] of [
			['eng', 'eng-public'],
			['eng-public', 'eng'],
		]) {
			const { store, state } = owned(principalRole);
			const response = await call(store, { body: { action: 'addDelegate', principal, machine: 'laptop', role } });
			assert.equal(response.status, 201, `${role} under ${principalRole}`);
			assert.equal(response.body.actsFor, false);
			assert.deepEqual(state.users.get(`${principal}.laptop`), { role, active: true });
			assert.equal(state.grants.has(`${principal}.laptop`), false);
			assert.equal(state.records.get(`${principal}.laptop`).principal, principal);
			const listed = await call(store, { method: 'GET', path: `/${principal}` });
			assert.deepEqual(listed.body.delegates, [{ username: `${principal}.laptop`, role, actsFor: false }]);
			const rotated = await call(store, { body: { action: 'rotate', username: `${principal}.laptop` } });
			assert.equal(rotated.status, 200);
		}
	});

	it('refuses a standalone delegate a leftover row that acts for anyone', async () => {
		const { store, state } = owned('eng', { grants: { [`${principal}.laptop`]: { actsFor: principal } } });
		const response = await call(store, {
			body: { action: 'addDelegate', principal, machine: 'laptop', role: 'eng-public' },
		});
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'grant_row_exists');
		assert.deepEqual(state.calls, []);
	});

	it('acts only for an active, managed principal holding an assignable role', async () => {
		const body = { action: 'addDelegate', principal, machine: 'laptop', role: 'eng' };
		const cases = [
			[fakeStore(), 404, 'user_not_found'],
			[fakeStore({ users: { [principal]: { role: 'eng' } } }), 403, 'not_managed'],
			[owned('eng', { users: { [principal]: { role: 'eng', active: false } } }), 403, 'user_inactive'],
			[owned('eng-agents'), 403, 'role_not_assignable'],
			[owned('super_user'), 403, 'role_not_assignable'],
			[
				owned('eng', { records: { [principal]: managed('pat@example.com', { machine: 'desk' }) } }),
				400,
				'not_a_principal',
			],
		];
		for (const [{ store, state }, status, code] of cases) {
			const response = await call(store, { body });
			assert.equal(response.status, status, code);
			assert.equal(response.body.code, code);
			assert.deepEqual(state.calls, []);
		}
	});

	it('answers 409 for a delegate that exists and past the delegate limit', async () => {
		const { store } = owned('eng');
		const body = { action: 'addDelegate', principal, machine: 'laptop', role: 'eng' };
		assert.equal((await call(store, { body })).status, 201);
		const again = await call(store, { body });
		assert.equal(again.status, 409);
		assert.equal(again.body.code, 'user_exists');

		const full = owned('eng');
		for (let i = 0; i < MAX_DELEGATES; i++) {
			full.state.users.set(`${principal}.m${i}`, { role: 'eng', active: true });
			full.state.records.set(
				`${principal}.m${i}`,
				managed(principal, { username: `${principal}.m${i}`, machine: `m${i}` }),
			);
		}
		const refused = await call(full.store, { body });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'too_many_delegates');
	});

	it('counts machine users still being created toward the limit, but not abandoned reservations', async () => {
		const body = { action: 'addDelegate', principal, machine: 'laptop', role: 'eng' };
		const fill = (state, extra) => {
			for (let i = 0; i < MAX_DELEGATES - 1; i++) {
				state.users.set(`${principal}.m${i}`, { role: 'eng', active: true });
				state.records.set(
					`${principal}.m${i}`,
					managed(principal, { username: `${principal}.m${i}`, machine: `m${i}` }),
				);
			}
			state.records.set(
				`${principal}.pending`,
				managed(principal, { username: `${principal}.pending`, machine: 'pending', ...extra }),
			);
		};
		const busy = owned('eng');
		fill(busy.state, { createdAt: new Date(NOW - 1_000) });
		const refused = await call(busy.store, { body });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'too_many_delegates');

		const abandoned = owned('eng');
		fill(abandoned.state, { createdAt: new Date(NOW - RESERVATION_TTL_MS - 1) });
		assert.equal((await call(abandoned.store, { body })).status, 201);
	});

	it('puts back the grant row after a takeover whose earlier request created the user', async () => {
		const delegate = `${principal}.laptop`;
		const staleAt = new Date(NOW - RESERVATION_TTL_MS - 1);
		const { store, state } = owned('eng', {
			records: {
				[principal]: managed(principal),
				[delegate]: managed(principal, { machine: 'laptop', createdAt: staleAt }),
			},
		});
		state.hooks.addUser = (name) => state.users.set(name, { role: 'eng-public', active: true });
		const response = await call(store, { body: { action: 'addDelegate', principal, machine: 'laptop', role: 'eng' } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_exists');
		assert.equal(state.grants.has(delegate), false);
		assert.equal(state.records.has(delegate), true);
	});

	it("drops the delegate's actsFor when the principal's role changes before the user is confirmed", async () => {
		const { store, state } = owned('eng-public');
		state.hooks.addUser = () => (state.users.get(principal).role = 'eng');
		const response = await call(store, {
			body: { action: 'addDelegate', principal, machine: 'laptop', role: 'eng-public' },
		});
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_changed');
		assert.equal(state.grants.has(`${principal}.laptop`), false);
	});

	it("issues nothing more in a group an admin's role change left mixed", async () => {
		const delegate = `${principal}.laptop`;
		const { store, state } = owned('eng', {
			users: { [principal]: { role: 'eng' }, [delegate]: { role: 'eng-public' } },
			records: { [principal]: managed(principal), [delegate]: managed(principal, { machine: 'laptop' }) },
			grants: { [delegate]: { actsFor: principal } },
		});
		for (const body of [
			{ action: 'addDelegate', principal, machine: 'desk', role: 'eng' },
			{ action: 'rotate', username: delegate },
			{ action: 'rotate', username: principal },
		]) {
			const response = await call(store, { body });
			assert.equal(response.status, 409, body.action);
			assert.equal(response.body.code, 'mixed_delegation');
		}
		assert.deepEqual(state.calls, []);
		state.grants.set(delegate, { actsFor: null });
		assert.equal((await call(store, { body: { action: 'rotate', username: delegate } })).status, 200);
	});

	it("re-checks the principal's role under the lock, so a role change mid-request issues nothing", async () => {
		const { store, state } = owned('eng-public');
		state.hooks.lock = () => (state.users.get(principal).role = 'eng');
		const response = await call(store, {
			body: { action: 'addDelegate', principal, machine: 'laptop', role: 'eng-public' },
		});
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_changed');
		assert.deepEqual(state.calls, []);
		assert.equal(state.grants.size, 0);
	});

	it('validates the machine label and the combined length', async () => {
		const { store } = owned();
		for (const machine of ['Laptop', 'my laptop', '', 'a'.repeat(33), 'a.b', 7]) {
			const response = await call(store, { body: { action: 'addDelegate', principal, machine, role: 'eng-public' } });
			assert.equal(response.status, 400, String(machine));
			assert.equal(response.body.code, 'invalid_machine');
		}
		const longPrincipal = `${'a'.repeat(100)}@example.com`;
		const long = fakeStore({
			users: { [longPrincipal]: { role: 'eng' } },
			records: { [longPrincipal]: managed(longPrincipal) },
		});
		const response = await call(long.store, {
			body: { action: 'addDelegate', principal: longPrincipal, machine: 'a'.repeat(20), role: 'eng' },
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.code, 'invalid_machine');
	});

	it('reuses the grant row of its own interrupted attempt, and restores a row it overwrote on release', async () => {
		const delegate = `${principal}.laptop`;
		const resumed = owned('eng', {
			grants: { [delegate]: { actsFor: principal } },
			records: { [principal]: managed(principal), [delegate]: managed(principal, { machine: 'laptop' }) },
		});
		const body = { action: 'addDelegate', principal, machine: 'laptop', role: 'eng' };
		assert.equal((await call(resumed.store, { body })).status, 201);

		const raced = owned('eng', { grants: { [delegate]: { actsFor: principal } } });
		raced.state.hooks.addUser = (name) => raced.state.users.set(name, { role: 'eng', active: true });
		assert.equal((await call(raced.store, { body })).status, 409);
		assert.equal(raced.state.records.has(delegate), false);
		assert.deepEqual(raced.state.grants.get(delegate), { actsFor: principal });

		const foreign = owned('eng', { grants: { [delegate]: { actsFor: 'pat@example.com' } } });
		const refused = await call(foreign.store, { body });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, 'grant_row_exists');
	});
});

describe('rotate', () => {
	const username = 'kris@example.com.laptop';
	const owned = (
		user = { role: 'eng' },
		records = { [username]: managed('kris@example.com', { machine: 'laptop' }) },
	) => fakeStore({ users: { [username]: user }, records });

	it('issues a new password for a managed user and changes nothing else', async () => {
		const { store, state } = owned();
		state.passwords.set(username, 'old');
		const response = await call(store, { body: { action: 'rotate', username } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(response.body.username, username);
		assert.notEqual(response.body.password, 'old');
		assert.equal(state.passwords.get(username), response.body.password);
		assert.deepEqual(state.users.get(username), { role: 'eng', active: true });
	});

	it('refuses users outside the flow, deactivated users and other roles, before writing', async () => {
		const cases = [
			[fakeStore(), 404, 'user_not_found'],
			[owned({ role: 'eng' }, {}), 403, 'not_managed'],
			[owned({ role: 'eng', active: false }), 403, 'user_inactive'],
			[owned({ role: 'super_user' }), 403, 'role_not_assignable'],
			[owned({ role: 'provisioner' }), 403, 'role_not_assignable'],
		];
		for (const [{ store, state }, status, code] of cases) {
			const response = await call(store, { body: { action: 'rotate', username } });
			assert.equal(response.status, status, code);
			assert.equal(response.body.code, code);
			assert.deepEqual(state.calls, []);
		}
		const { store } = fakeStore();
		assert.equal((await call(store, { body: { action: 'rotate', username: 'bad name' } })).status, 400);
	});

	it('withholds the password, and leaves an admin reset alone, when an admin changes the user mid-rotation', async () => {
		const { store, state } = owned();
		state.hooks.authenticate = () => {
			state.users.get(username).role = 'super_user';
			state.passwords.set(username, 'admin-reset');
		};
		const response = await call(store, { body: { action: 'rotate', username } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_changed');
		assert.equal(response.body.password, undefined);
		assert.deepEqual(state.calls, [['setPassword', username]]);
		assert.equal(state.passwords.get(username), 'admin-reset');
	});

	it('withholds its password when a competing rotation won', async () => {
		const { store, state } = owned();
		state.hooks.authenticate = () => state.passwords.set(username, 'the-other-rotation');
		const response = await call(store, { body: { action: 'rotate', username } });
		assert.equal(response.status, 409);
		assert.equal(response.body.code, 'user_changed');
		assert.equal(state.passwords.get(username), 'the-other-rotation');
	});
});

describe('describe (GET)', () => {
	it('reports a managed principal with its live delegates, their roles and whether each acts for it', async () => {
		const principal = 'kris@example.com';
		const { store } = fakeStore({
			users: {
				[principal]: { role: 'eng-public' },
				[`${principal}.laptop`]: { role: 'eng-public' },
				[`${principal}.old`]: { role: 'super_user' },
			},
			records: {
				[principal]: managed(principal),
				[`${principal}.laptop`]: managed(principal, { machine: 'laptop' }),
				[`${principal}.old`]: managed(principal, { machine: 'old' }),
				[`${principal}.gone`]: managed(principal, { machine: 'gone' }),
			},
			grants: { [`${principal}.laptop`]: { actsFor: principal }, [`${principal}.old`]: { actsFor: null } },
		});
		const response = await call(store, { method: 'GET', path: `/${principal}` });
		assert.equal(response.status, 200);
		assert.deepEqual(response.body, {
			exists: true,
			managed: true,
			role: 'eng-public',
			delegates: [
				{ username: `${principal}.laptop`, role: 'eng-public', actsFor: true },
				{ username: `${principal}.old`, role: null, actsFor: false },
			],
		});
	});

	it('reports a missing user, an admin-made user, and hides roles provisioning does not manage', async () => {
		const { store } = fakeStore({
			users: { 'kris@example.com': { role: 'eng' }, 'root@example.com': { role: 'super_user' } },
		});
		assert.deepEqual((await call(store, { method: 'GET', path: '/pat@example.com' })).body, {
			exists: false,
			managed: false,
			role: null,
			delegates: [],
		});
		assert.deepEqual((await call(store, { method: 'GET', path: '/kris@example.com' })).body, {
			exists: true,
			managed: false,
			role: 'eng',
			delegates: [],
		});
		assert.equal((await call(store, { method: 'GET', path: '/root@example.com' })).body.role, null);
		assert.equal((await call(store, { method: 'GET', path: '/' })).status, 400);
	});

	it('reports managed only where rotate would succeed', async () => {
		const { store } = fakeStore({
			users: { 'off@example.com': { role: 'eng', active: false }, 'up@example.com': { role: 'super_user' } },
			records: { 'off@example.com': managed('off@example.com'), 'up@example.com': managed('up@example.com') },
		});
		for (const name of ['off@example.com', 'up@example.com']) {
			const response = await call(store, { method: 'GET', path: `/${name}` });
			assert.equal(response.body.exists, true);
			assert.equal(response.body.managed, false, name);
		}
	});
});

describe('failure logging', () => {
	let logged;
	beforeEach(() => {
		logged = [];
		logger.error = (...args) => logged.push(args.map(String).join(' '));
	});

	it('logs the stage and a reference, never the cause text or a password', async () => {
		const { store, state } = fakeStore({
			users: { 'kris@example.com': { role: 'eng' } },
			records: { 'kris@example.com': managed('kris@example.com') },
		});
		state.hooks.setPassword = () => {
			throw new Error(`upstream echoed ${[...state.passwords.values()].join(',')} Basic a3JpczpzZWNyZXQ=`);
		};
		state.passwords.set('kris@example.com', 'previous-secret');
		const response = await call(store, { body: { action: 'rotate', username: 'kris@example.com' } });
		assert.equal(response.status, 500);
		assert.equal(logged.length, 1);
		assert.match(logged[0], new RegExp(`set_password \\(ref ${response.body.ref}\\)`));
		assert.doesNotMatch(logged[0], /upstream|previous-secret|Basic/);
	});
});
