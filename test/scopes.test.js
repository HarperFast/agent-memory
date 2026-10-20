import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	assertWritable,
	canRead,
	compileMatcher,
	createPrincipal,
	isSuperset,
	matches,
	MAX_GRANT_PATTERNS,
	MAX_SCOPES_PER_MEMORY,
	normalizeScopes,
	readableConditions,
	readsCustomerContent,
	requirePrincipalId,
	reviewsCustomerContent,
} from '../dist/scopes.js';

const principal = (id, read = [], write = [], superUser = false) =>
	createPrincipal({ id, grants: { read, write }, superUser });

// Mirrors Harper's record predicate: an array value matches when any element does (resources/search.ts).
function evaluate(condition, record) {
	if (condition.conditions) {
		const results = condition.conditions.map((child) => evaluate(child, record));
		return condition.operator === 'or' ? results.some(Boolean) : results.every(Boolean);
	}
	const value = record[condition.attribute];
	if (condition.comparator === 'not_equal') return value !== condition.value;
	const test = (value) => {
		if (condition.comparator === 'equals') return value === condition.value;
		if (condition.comparator === 'gelt') return value >= condition.value[0] && value < condition.value[1];
		throw new Error(`unexpected comparator ${condition.comparator}`);
	};
	return Array.isArray(value) ? value.some(test) : test(value);
}

const evaluateAll = (conditions, record) => conditions.every((condition) => evaluate(condition, record));

function rejects(fn, statusCode, code) {
	assert.throws(fn, (error) => error.statusCode === statusCode && error.code === code);
}

describe('principal ids', () => {
	it('accepts up to 122 characters without whitespace, ":" or "*"', () => {
		assert.equal(requirePrincipalId('a'.repeat(122)), 'a'.repeat(122));
		assert.equal(requirePrincipalId('alice@harperdb.io'), 'alice@harperdb.io');
	});

	it('rejects ids that could forge or widen a label', () => {
		rejects(() => requirePrincipalId('a'.repeat(123)), 400, 'principal_too_long');
		for (const id of ['user:bob', 'all*', 'two words', 'tab\there', 'line\nbreak']) {
			rejects(() => requirePrincipalId(id), 400, 'invalid_principal_id');
		}
	});

	it('treats a missing id as unauthenticated', () => {
		for (const id of [undefined, null, '', 42]) rejects(() => requirePrincipalId(id), 401, 'principal_required');
	});
});

describe('grant matching', () => {
	it('always grants the principal its own user scope', () => {
		const alice = principal('alice');
		assert.ok(matches(alice.read, 'user:alice'));
		assert.ok(matches(alice.write, 'user:alice'));
		assert.ok(!matches(alice.read, 'user:bob'));
		assert.ok(!matches(alice.read, 'global'));
	});

	it('matches a namespace wildcard against every label in that namespace only', () => {
		const dave = principal('dave', ['customer:*']);
		assert.ok(matches(dave.read, 'customer:x'));
		assert.ok(matches(dave.read, 'customer:acme:eu'));
		assert.ok(!matches(dave.read, 'customers:x'));
		assert.ok(!matches(dave.read, 'team:x'));
		assert.ok(!matches(dave.write, 'customer:x'), 'read grants never imply write');
	});

	it('ignores every grant in the user namespace, so user:<id> stays private to its owner', () => {
		const { matcher, rejected } = compileMatcher(['user:*', 'user:alice', 'team:a'], 'eve');
		assert.deepEqual([...matcher.exact].sort(), ['team:a', 'user:eve']);
		assert.equal(matcher.namespaces.size, 0);
		assert.deepEqual(rejected, ['user:*', 'user:alice']);
		assert.ok(!canRead({ ownerId: 'alice', scopes: ['user:alice'], status: 'active' }, principal('eve', ['user:*'])));
	});

	it('never lets a wildcard cover the bare global label', () => {
		assert.ok(!matches(principal('eve', ['global:*']).read, 'global'));
	});

	it('ignores invalid patterns, and patterns past the cap, instead of widening', () => {
		const { matcher, rejected } = compileMatcher(['*', 'cust*', 'customer:x*', ' global', 'customer:x', 42], 'eve');
		assert.deepEqual([...matcher.exact].sort(), ['customer:x', 'user:eve']);
		assert.equal(matcher.namespaces.size, 0);
		assert.deepEqual(rejected, ['*', 'cust*', 'customer:x*', ' global', 42]);

		const many = Array.from({ length: MAX_GRANT_PATTERNS + 5 }, (_, i) => `team:t${i}`);
		const capped = compileMatcher(many, 'eve');
		assert.equal(capped.matcher.exact.size, MAX_GRANT_PATTERNS + 1);
		assert.equal(capped.rejected.length, 5);
	});

	it('reports rejected patterns to the caller of createPrincipal', () => {
		const reported = [];
		createPrincipal({ id: 'eve', grants: { read: ['bad*'], write: ['also bad'] } }, (pattern) =>
			reported.push(pattern),
		);
		assert.deepEqual(reported, ['bad*', 'also bad']);
	});
});

describe('read rule', () => {
	const memory = { ownerId: 'alice', scopes: ['customer:x'], status: 'active' };

	it('admits the owner, super_user, and any label overlap', () => {
		assert.ok(canRead(memory, principal('alice')));
		assert.ok(canRead(memory, principal('root', [], [], true)));
		assert.ok(canRead(memory, principal('carol', ['customer:x'])));
		assert.ok(canRead(memory, principal('dave', ['customer:*'])));
		assert.ok(canRead({ ...memory, scopes: ['team:a', 'customer:x'] }, principal('carol', ['customer:x'])));
	});

	it('refuses a principal with no overlapping label', () => {
		assert.ok(!canRead(memory, principal('bob', ['global', 'customer:y'])));
		assert.ok(!canRead({ ...memory, scopes: ['user:alice'] }, principal('bob', ['customer:*'])));
	});

	it('shows a withdrawn memory to its owner and super_user only', () => {
		const withdrawn = { ...memory, status: 'withdrawn' };
		assert.ok(canRead(withdrawn, principal('alice')));
		assert.ok(canRead(withdrawn, principal('root', [], [], true)));
		assert.ok(!canRead(withdrawn, principal('carol', ['customer:x'])));
	});
});

describe('write rule', () => {
	it('requires every label to be writable', () => {
		const carol = principal('carol', [], ['customer:x']);
		assertWritable(['customer:x', 'user:carol'], carol);
		rejects(() => assertWritable(['customer:x', 'global'], carol), 403, 'scope_not_writable');
		assertWritable(['anything:at-all'], principal('root', [], [], true));
	});

	it('supersede requires the new scopes to cover the old ones', () => {
		assert.ok(isSuperset(['global', 'customer:x'], ['customer:x']));
		assert.ok(isSuperset(['customer:x'], ['customer:x']));
		assert.ok(!isSuperset(['global'], ['customer:x']));
	});
});

describe('normalizeScopes', () => {
	it('maps visibility shorthand, defaulting to private', () => {
		assert.deepEqual(normalizeScopes(undefined, undefined, 'alice'), ['user:alice']);
		assert.deepEqual(normalizeScopes(undefined, 'private', 'alice'), ['user:alice']);
		assert.deepEqual(normalizeScopes(undefined, 'shared', 'alice'), ['global']);
		rejects(() => normalizeScopes(undefined, 'public', 'alice'), 400, 'invalid_visibility');
	});

	it('lets explicit scopes win, deduplicated and sorted', () => {
		assert.deepEqual(normalizeScopes(['team:b', 'global', 'team:b'], 'private', 'alice'), ['global', 'team:b']);
	});

	it('rejects malformed labels and too many of them', () => {
		for (const bad of [
			[],
			'global',
			['customer:*'],
			['nocolon'],
			['customer: x'],
			[':x'],
			['x:'],
			['x:'.padEnd(129, 'y')],
		]) {
			assert.throws(
				() => normalizeScopes(bad, undefined, 'alice'),
				(error) => error.statusCode === 400,
				JSON.stringify(bad),
			);
		}
		const tooMany = Array.from({ length: MAX_SCOPES_PER_MEMORY + 1 }, (_, i) => `team:t${i}`);
		rejects(() => normalizeScopes(tooMany, undefined, 'alice'), 400, 'too_many_scopes');
	});
});

describe('readableConditions', () => {
	it('is empty for super_user, who reads everything', () => {
		assert.deepEqual(readableConditions(principal('root', [], [], true)), []);
	});

	it('expresses a wildcard as the exact prefix range, which Harper can plan from the index', () => {
		const [condition, ...rest] = readableConditions(principal('dave', ['customer:*', 'global']));
		assert.deepEqual(rest, []);
		assert.equal(condition.operator, 'or');
		assert.deepEqual(condition.conditions, [
			{ attribute: 'ownerId', comparator: 'equals', value: 'dave' },
			{ attribute: 'scopes', comparator: 'equals', value: 'user:dave' },
			{ attribute: 'scopes', comparator: 'equals', value: 'global' },
			{ attribute: 'scopes', comparator: 'gelt', value: ['customer:', 'customer;'] },
		]);
	});

	it('adds the quarantine as its own group for a principal not cleared for customer content', () => {
		const conditions = readableConditions(principal('carol', ['customer:x', 'global']));
		assert.equal(conditions.length, 2);
		assert.deepEqual(conditions[1], {
			operator: 'or',
			conditions: [
				{ attribute: 'contentFlagged', comparator: 'not_equal', value: true },
				{ attribute: 'ownerId', comparator: 'equals', value: 'carol' },
			],
		});
	});

	it('agrees with canRead on every non-withdrawn record, flagged or not, including rows written before the flag', () => {
		const readers = [
			principal('alice'),
			principal('carol', ['customer:x']),
			principal('dave', ['customer:*', 'global']),
			principal('erin', ['team:a', 'team:*']),
			principal('fleet', ['global']),
		];
		const flag = { kind: 'possible-customer-detail', since: '2026-10-20T00:00:00.000Z', source: 'pattern' };
		const records = [
			{ ownerId: 'alice', scopes: ['user:alice'] },
			{ ownerId: 'bob', scopes: ['customer:x'] },
			{ ownerId: 'bob', scopes: ['customer:xy'] },
			{ ownerId: 'bob', scopes: ['customers:x'] },
			{ ownerId: 'bob', scopes: ['customer'] },
			{ ownerId: 'bob', scopes: ['global', 'team:a'] },
			{ ownerId: 'alice', scopes: ['team:z'] },
			{ ownerId: 'bob', scopes: ['user:bob'] },
			{ ownerId: 'bob', scopes: ['global'], contentFlagged: null, contentFlag: null },
			{ ownerId: 'bob', scopes: ['global'], contentFlagged: true, contentFlag: flag },
			{ ownerId: 'bob', scopes: ['customer:x', 'global'], contentFlagged: true, contentFlag: flag },
			{ ownerId: 'bob', scopes: ['global', 'team:a'], contentFlagged: true, contentFlag: flag },
			{ ownerId: 'alice', scopes: ['global'], contentFlagged: true, contentFlag: flag },
			{ ownerId: 'fleet', scopes: ['global'], contentFlagged: true, contentFlag: flag },
		].map((record) => ({ ...record, status: 'active' }));
		for (const reader of readers) {
			for (const record of records) {
				assert.equal(
					evaluateAll(readableConditions(reader), record),
					canRead(record, reader),
					`${reader.id} on ${JSON.stringify(record)}`,
				);
			}
		}
	});
});

describe('the customer-content quarantine', () => {
	const flagged = {
		ownerId: 'bob',
		scopes: ['global'],
		status: 'active',
		contentFlag: { kind: 'possible-customer-detail', since: '2026-10-20T00:00:00.000Z', source: 'pattern' },
	};

	it('hides a flagged memory from a global reader, an exact customer grant and a write-only wildcard', () => {
		for (const reader of [
			principal('fleet', ['global']),
			principal('carol', ['customer:x', 'global']),
			principal('wanda', ['global'], ['customer:*']),
		]) {
			assert.equal(canRead(flagged, reader), false, reader.id);
		}
	});

	it('lets the owner, super_user and a customer:* reader read it, and grants nothing beyond the labels', () => {
		assert.equal(canRead(flagged, principal('bob')), true);
		assert.equal(canRead(flagged, principal('root', [], [], true)), true);
		assert.equal(canRead(flagged, principal('dave', ['customer:*', 'global'])), true);
		assert.equal(canRead(flagged, principal('dora', ['customer:*'])), false);
	});

	it('names clearance by wildcard grants only', () => {
		assert.equal(readsCustomerContent(principal('dave', ['customer:*'])), true);
		assert.equal(readsCustomerContent(principal('carol', ['customer:x'])), false);
		assert.equal(reviewsCustomerContent(principal('dave', ['customer:*'])), false);
		assert.equal(reviewsCustomerContent(principal('dave', [], ['customer:*'])), false);
		assert.equal(reviewsCustomerContent(principal('dave', ['customer:*'], ['customer:*'])), true);
		assert.equal(reviewsCustomerContent(principal('root', [], [], true)), true);
	});
});
