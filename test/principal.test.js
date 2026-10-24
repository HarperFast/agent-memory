import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import { canReadLabels, resolvePrincipal, setPrincipalResolver } from '../dist/index.js';
import { canRead, MAX_GRANT_PATTERNS } from '../dist/scopes.js';

const member = (username, role = 'agents') => ({ user: { username, role: { role, permission: {} } } });
const superUser = { user: { username: 'root', role: { role: 'super_user', permission: { super_user: true } } } };

async function grant(key, read = [], write = []) {
	await databases.memory.ScopeGrant.put({ id: key, read, write });
}

async function rejectsWith(promise, statusCode, code) {
	await assert.rejects(promise, (error) => error.statusCode === statusCode && error.code === code);
}

beforeEach(() => __test.reset());
afterEach(() => setPrincipalResolver(undefined));

describe('resolvePrincipal', () => {
	it('merges role and user grants into deduplicated effective patterns, its own user label first', async () => {
		await grant('role:agents', ['team:a', 'customer:acme', 'global'], ['team:a']);
		await grant('user:alice', ['global', 'customer:*', 'team:a'], ['team:a', 'global']);
		const alice = await resolvePrincipal(member('alice'));
		assert.deepEqual(alice, {
			id: 'alice',
			superUser: false,
			source: 'harper',
			read: ['user:alice', 'team:a', 'global', 'customer:*'],
			write: ['user:alice', 'team:a', 'global'],
		});
	});

	it('lists only patterns that grant something', async () => {
		await grant('role:agents', ['user:*', 'user:bob', 'two words', '*', 'cust*', 42, 'team:b'], ['*:*', 'user:eve']);
		const eve = await resolvePrincipal(member('eve'));
		assert.deepEqual(eve.read, ['user:eve', 'team:b']);
		assert.deepEqual(eve.write, ['user:eve']);

		const many = Array.from({ length: MAX_GRANT_PATTERNS + 10 }, (_, i) => `team:t${i}`);
		await grant('user:eve', many);
		const capped = await resolvePrincipal(member('eve'));
		assert.equal(capped.read.length, MAX_GRANT_PATTERNS + 1);
	});

	it('grants only the implicit user label to a user with no grant rows, and reads the user row without a role', async () => {
		assert.deepEqual((await resolvePrincipal(member('frank'))).read, ['user:frank']);
		await grant('user:gina', ['team:g']);
		assert.deepEqual((await resolvePrincipal({ user: { username: 'gina' } })).read, ['user:gina', 'team:g']);
	});

	it('reports super_user explicitly; its lists do not enumerate its access', async () => {
		const root = await resolvePrincipal(superUser);
		assert.equal(root.superUser, true);
		assert.deepEqual(root.read, ['user:root']);
		assert.deepEqual(root.write, ['user:root']);
		assert.ok(canReadLabels(root, ['customer:anyone']));
	});

	it('returns a frozen principal with frozen lists', async () => {
		await grant('user:alice', ['global']);
		const alice = await resolvePrincipal(member('alice'));
		for (const value of [alice, alice.read, alice.write]) assert.ok(Object.isFrozen(value));
		assert.throws(() => alice.read.push('customer:*'), TypeError);
		assert.throws(() => {
			alice.superUser = true;
		}, TypeError);
		assert.deepEqual(alice.read, ['user:alice', 'global']);
	});

	it('honors a custom resolver, which can defer to the Harper user with next()', async () => {
		await grant('user:alice', ['global']);
		setPrincipalResolver((context, next) =>
			context.headers?.['x-api-key'] === 'reflex-key'
				? { id: 'reflex-svc', grants: { read: ['team:*', 'global'], write: [] }, source: 'api-key' }
				: next(),
		);
		assert.deepEqual(await resolvePrincipal({ headers: { 'x-api-key': 'reflex-key' } }), {
			id: 'reflex-svc',
			superUser: false,
			source: 'api-key',
			read: ['user:reflex-svc', 'global', 'team:*'],
			write: ['user:reflex-svc'],
		});
		assert.deepEqual((await resolvePrincipal(member('alice'))).read, ['user:alice', 'global']);
		await rejectsWith(resolvePrincipal({ headers: {} }), 401, 'principal_required');
	});

	it('rejects with 401 when there is no caller', async () => {
		await rejectsWith(resolvePrincipal({}), 401, 'principal_required');
		await rejectsWith(resolvePrincipal(undefined), 401, 'principal_required');
		setPrincipalResolver(() => undefined);
		await rejectsWith(resolvePrincipal(member('alice')), 401, 'principal_required');
	});

	it('rejects with the original error when a grant read or the resolver fails', async () => {
		const ScopeGrant = databases.memory.ScopeGrant;
		const originalGet = ScopeGrant.get;
		const outage = new Error('storage unavailable');
		ScopeGrant.get = async () => {
			throw outage;
		};
		try {
			await assert.rejects(resolvePrincipal(member('alice')), (error) => error === outage);
		} finally {
			ScopeGrant.get = originalGet;
		}
		const broken = new Error('key lookup failed');
		setPrincipalResolver(() => {
			throw broken;
		});
		await assert.rejects(resolvePrincipal(member('alice')), (error) => error === broken);
	});

	it("reads grants in a context of its own, leaving the caller's pending authorization untouched", async () => {
		const ScopeGrant = databases.memory.ScopeGrant;
		const originalGet = ScopeGrant.get;
		const contexts = [];
		ScopeGrant.get = function (id, context) {
			contexts.push(context);
			return originalGet.call(this, id, context);
		};
		const caller = { ...member('alice'), authorize: true };
		try {
			await resolvePrincipal(caller);
		} finally {
			ScopeGrant.get = originalGet;
		}
		assert.equal(contexts.length, 2);
		for (const context of contexts) {
			assert.notEqual(context, caller);
			assert.equal(context.authorize, false);
		}
		assert.equal(caller.authorize, true);
	});

	it('reads grants on every call, so a revoked grant is gone from the next principal', async () => {
		await grant('user:alice', ['team:a']);
		assert.ok(canReadLabels(await resolvePrincipal(member('alice')), ['team:a']));
		await databases.memory.ScopeGrant.delete('user:alice');
		assert.ok(!canReadLabels(await resolvePrincipal(member('alice')), ['team:a']));
	});
});

describe('canReadLabels', () => {
	async function principalWith(read) {
		await grant('user:pat', read);
		return resolvePrincipal(member('pat', 'none'));
	}

	it('matches exact labels and namespace wildcards when ANY label overlaps', async () => {
		const pat = await principalWith(['team:a', 'customer:*']);
		assert.ok(canReadLabels(pat, ['team:a']));
		assert.ok(canReadLabels(pat, ['customer:acme']));
		assert.ok(canReadLabels(pat, ['customer:acme:eu']));
		assert.ok(canReadLabels(pat, ['team:z', 'global', 'team:a']), 'one readable label is enough');
		assert.ok(canReadLabels(pat, ['user:pat']), 'its own private label');
		assert.ok(!canReadLabels(pat, ['team:z', 'global']));
		assert.ok(!canReadLabels(pat, ['customers:acme']));
		assert.ok(!canReadLabels(pat, ['user:alice']), "another user's private label");
		assert.ok(!canReadLabels(pat, []));
	});

	it('never lets a wildcard cover the bare global label', async () => {
		const pat = await principalWith(['customer:*', 'team:*']);
		assert.ok(!canReadLabels(pat, ['global']));
		assert.ok(canReadLabels(await principalWith(['global']), ['global']));
	});

	it('ignores labels that are not strings, and treats a missing label list as no labels', async () => {
		const pat = await principalWith(['team:a']);
		assert.ok(!canReadLabels(pat, [null, 42, undefined]));
		assert.ok(canReadLabels(pat, [null, 'team:a']));
		for (const labels of [undefined, null, 'team:a']) assert.ok(!canReadLabels(pat, labels));
		assert.ok(canReadLabels(await resolvePrincipal(superUser), undefined), 'super_user reads unlabeled records');
	});

	it('agrees with canRead on every active, unflagged record the principal does not own', async () => {
		const readers = [
			await principalWith([]),
			await principalWith(['global']),
			await principalWith(['customer:x', 'team:*']),
			await resolvePrincipal(superUser),
		];
		const labelSets = [
			['global'],
			['customer:x'],
			['customer:y'],
			['team:q', 'customer:y'],
			['user:pat'],
			['user:zed'],
		];
		for (const reader of readers) {
			for (const scopes of labelSets) {
				assert.equal(
					canReadLabels(reader, scopes),
					canRead({ ownerId: 'zed', scopes, status: 'active' }, reader),
					`${JSON.stringify(reader.read)} on ${JSON.stringify(scopes)}`,
				);
			}
		}
	});

	it('accepts only a principal resolvePrincipal returned', async () => {
		const pat = await principalWith(['global']);
		assert.throws(() => canReadLabels(JSON.parse(JSON.stringify(pat)), ['global']), TypeError);
		assert.throws(() => canReadLabels({ ...pat, read: [...pat.read] }, ['global']), TypeError);
		assert.throws(
			() => canReadLabels({ id: 'x', superUser: true, source: 'forged', read: [], write: [] }, ['global']),
			TypeError,
		);
		assert.throws(() => canReadLabels({ ...pat }, ['global']), TypeError);
		assert.throws(() => canReadLabels({ ...pat, superUser: true }, ['customer:any']), TypeError);
		assert.throws(() => canReadLabels(structuredClone(pat), ['global']), TypeError);
		assert.throws(() => canReadLabels({ ...pat, read: pat.write }, ['global']), TypeError);
		assert.throws(() => canReadLabels(Object.create(pat, { superUser: { value: true } }), ['customer:any']), TypeError);
	});
});
