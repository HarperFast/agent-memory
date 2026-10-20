import { after, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test, databases, models } from 'harper';
import { importMemories } from '../dist/import.js';
import {
	confirmMemory,
	confirmScopeMemory,
	getMemory,
	pinMemory,
	putMemory,
	withdrawMemory,
} from '../dist/lifecycle.js';
import { checkedText, matchCustomerContent, parseContentCheck } from '../dist/patterns.js';
import { MemoryEventsResource, MemoryItemResource, MemoryResource } from '../dist/resource.js';
import { searchMemories } from '../dist/search.js';
import { createPrincipal } from '../dist/scopes.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { registerMemorySink } from '../dist/sinks.js';

// Synthetic names only: the real list is server-side configuration and never enters the repository.
const NAMES = { zorblax: ['Zorblax Industries', 'Zorblax'], quintessa: ['Quintessa Bank', 'QB Holdings'] };
const HOSTS = [
	{ label: 'zorb-host', host: '*.zorbcloud.test' },
	{ label: 'zorb-db', host: 'db.zorb.test' },
	{ label: 'lab-ip', cidr: '10.77.0.0/16' },
	{ label: 'lab-ip6', cidr: '2001:db8:77::/48' },
];
const scratch = mkdtempSync(join(tmpdir(), 'agent-memory-quarantine-'));
const namesFile = join(scratch, 'names.json');
writeFileSync(namesFile, JSON.stringify(NAMES));
after(() => rmSync(scratch, { recursive: true, force: true }));

const configure = (check = {}) =>
	applySettings(parseSettings({ customerContentCheck: { patterns: { namesFile, hosts: HOSTS }, ...check } }));

const grant = (id, read, write) => createPrincipal({ id, grants: { read, write } });
const fleet = grant('fleet', ['global'], ['global']);
const fleet2 = grant('fleet2', ['global'], ['global']);
const dave = grant('dave', ['customer:*', 'global'], ['customer:*', 'global']);
const rhea = grant('rhea', ['customer:*', 'global'], ['global']);
const wanda = grant('wanda', ['global'], ['customer:*', 'global']);
const carol = grant('carol', ['customer:zorblax', 'global'], ['customer:zorblax', 'global']);
const context = { user: { username: 'request-user' } };
const ifMatch = (revision) => ({ ...context, headers: { 'if-match': `"${revision}"` } });
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const stored = (id) => __test.stores.get('Memory').get(id);

async function rejection(promise, statusCode, code) {
	const error = await promise.then(
		() => null,
		(reason) => reason,
	);
	assert.ok(error, 'expected the call to reject');
	assert.equal(error.statusCode, statusCode, error.message);
	if (code) assert.equal(error.code, code);
	return error;
}

async function eventually(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail('condition not reached');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const shared = (content, extra = {}) => ({ title: 'Lab notes', content, visibility: 'shared', ...extra });

beforeEach(() => {
	__test.reset();
	configure();
});

describe('patterns', () => {
	const { matcher } = parseContentCheck({ patterns: { namesFile, hosts: HOSTS } }, () => undefined);

	it('matches names and aliases as whole token sequences, case- and punctuation-insensitively', () => {
		assert.deepEqual(matchCustomerContent('Met with zorblax-industries today', matcher), ['customer:zorblax']);
		assert.deepEqual(matchCustomerContent('QB  Holdings, and Quintessa', matcher), ['customer:quintessa']);
		assert.deepEqual(matchCustomerContent('ZORBLAXIAN pottery; quintessential', matcher), []);
		assert.deepEqual(matchCustomerContent('ｚｏｒｂｌａｘ fullwidth', matcher), ['customer:zorblax']);
	});

	it('labels host and address matches, and finds names inside host names', () => {
		assert.deepEqual(matchCustomerContent('see zorblax-prod.zorbcloud.test and 10.77.4.2', matcher), [
			'customer:zorblax',
			'lab-ip',
			'zorb-host',
		]);
		assert.deepEqual(
			matchCustomerContent('https://DB.zorb.test:8443/x, [2001:db8:77::9]:443 and A.B.ZorbCloud.Test.', matcher),
			['lab-ip6', 'zorb-db', 'zorb-host'],
		);
		assert.deepEqual(
			matchCustomerContent('localhost 127.0.0.1 10.78.0.1 zorbcloud.test db.zorb.test.example 2001:db8:78::1', matcher),
			[],
		);
		for (const [text, labels] of [
			['Connect to 2001:db8:77::9.', ['lab-ip6']],
			['mapped as ::ffff:10.77.4.2', ['lab-ip']],
			['each <db>.zorbcloud.test, ${env}.zorbcloud.test or *.zorbcloud.test', ['zorb-host']],
			['prod_db.zorbcloud.test', ['zorb-host']],
			['See _db.zorb.test_, _10.77.4.2_ and _2001:db8:77::9_', ['lab-ip', 'lab-ip6', 'zorb-db']],
			['2001:db8:77::9: connection refused', ['lab-ip6']],
		]) {
			assert.deepEqual(matchCustomerContent(text, matcher), labels, text);
		}
	});

	it('matches in time linear in the text, whatever the text', () => {
		const started = performance.now();
		for (const filler of ['.', '-', ':', 'a.', '1.', 'f:', '[', 'Zorblax ']) {
			matchCustomerContent(filler.repeat(100_000 / filler.length), matcher);
		}
		assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
	});

	it('matches in time bounded by the longest name, not by how many names share a first word', () => {
		const names = { company: Array.from({ length: 50_000 }, (_, i) => `The Company ${i}`) };
		const check = parseContentCheck({ patterns: { namesSecret: 'N' } }, () => ({ N: JSON.stringify(names) }));
		const started = performance.now();
		assert.deepEqual(matchCustomerContent('The '.repeat(5000), check.matcher), []);
		assert.deepEqual(matchCustomerContent('see the company 49999 runbook', check.matcher), ['customer:company']);
		assert.ok(performance.now() - started < 500, `${performance.now() - started} ms`);
	});

	it('emits a name shared by many organizations once per text, and compiles them in linear time', () => {
		const names = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`bank${i}`, ['Bank']]));
		const started = performance.now();
		const check = parseContentCheck({ patterns: { namesSecret: 'N' } }, () => ({ N: JSON.stringify(names) }));
		assert.equal(matchCustomerContent('Bank '.repeat(4000), check.matcher).length, 50_000);
		assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
	});

	it('reads every author-written field and the chosen id', () => {
		assert.deepEqual(matchCustomerContent(checkedText({ id: 'zorblax-failover-runbook' }), matcher), [
			'customer:zorblax',
		]);
		const text = checkedText({
			id: 'mem-plain-0000001',
			title: 'title',
			content: 'content',
			tags: ['tag-a'],
			evidence: [{ kind: 'url', ref: 'https://db1.zorbcloud.test/x', note: 'note' }],
		});
		assert.deepEqual(matchCustomerContent(text, matcher), ['zorb-host']);
	});

	it('loads the list from a component secret', () => {
		const check = parseContentCheck({ patterns: { namesSecret: 'NAMES' } }, () => ({ NAMES: JSON.stringify(NAMES) }));
		assert.deepEqual(matchCustomerContent('Quintessa Bank', check.matcher), ['customer:quintessa']);
	});

	it('is off when absent or off, and never reads the list then', () => {
		assert.equal(parseContentCheck(undefined, () => undefined).mode, 'off');
		assert.equal(parseContentCheck({ mode: 'off', patterns: { namesFile: '/missing' } }, () => undefined).mode, 'off');
	});

	it('refuses malformed configuration without echoing the list or its keys', () => {
		const secret = (value) => () => ({ NAMES: value });
		const cases = [
			[{ patterns: { namesFile: 'relative/names.json' } }],
			[{ patterns: { namesFile: join(scratch, 'missing.json') } }],
			[{ patterns: { namesFile, namesSecret: 'NAMES' } }],
			[{ patterns: { namesSecret: 'NAMES' } }, () => ({})],
			[{ patterns: { namesSecret: 'NAMES' } }, secret('{"zorblax": ["Zorblax"')],
			[{ patterns: { namesSecret: 'NAMES' } }, secret('["Zorblax"]')],
			[{ patterns: { namesSecret: 'NAMES' } }, secret('{"zorblax inc": ["Zorblax"]}')],
			[{ patterns: { namesSecret: 'NAMES' } }, secret('{"zorblax": []}')],
			[{ patterns: { namesSecret: 'NAMES' } }, secret('{"zorblax": ["!!!"]}')],
			[{ patterns: { hosts: [{ label: 'x', regex: 'zorbcloud' }] } }],
			[{ patterns: { hosts: [{ label: 'x', host: 'zorbcloud.test', cidr: '10.0.0.0/8' }] } }],
			[{ patterns: { hosts: [{ label: 'x', host: 'zorbcloud' }] } }],
			[{ patterns: { hosts: [{ label: 'x', host: '*.zorb_cloud.test' }] } }],
			[{ patterns: { hosts: [{ label: 'x', host: 'db.*.zorbcloud.test' }] } }],
			[{ patterns: { hosts: [{ label: 'x', cidr: '10.77.0.0/33' }] } }],
			[{ patterns: { hosts: [{ label: 'x', cidr: '10.77.0/16' }] } }],
			[{ patterns: { hosts: [{ label: 'bad label', host: 'zorbcloud.test' }] } }],
			[{ mode: 'block' }],
			[{ model: '' }],
			[{ patterns: { names: 'zorblax' } }],
		];
		for (const [options, secrets = () => undefined] of cases) {
			assert.throws(
				() => parseContentCheck(options, secrets),
				(error) => {
					assert.match(error.message, /customerContentCheck/);
					assert.doesNotMatch(error.message, /zorblax|zorbcloud|Zorblax/i, error.message);
					assert.equal(error.cause, undefined);
					return true;
				},
				JSON.stringify(options),
			);
		}
	});
});

describe('flagging on write', () => {
	it('commits a global write that names a customer, flagged, and never rejects it', async () => {
		const { created, memory } = await putMemory(
			idFor('flag-1'),
			shared('Zorblax asked about replication'),
			fleet,
			context,
		);
		assert.equal(created, true);
		assert.deepEqual(stored(idFor('flag-1')).contentFlag.labels, ['customer:zorblax']);
		assert.equal(stored(idFor('flag-1')).contentFlagged, true);
		assert.deepEqual(Object.keys(memory.contentFlag).sort(), ['kind', 'since', 'source']);
		assert.equal(memory.contentFlag.source, 'pattern');
	});

	it('flags a global write whose chosen id, or an id it supersedes, names a customer', async () => {
		await putMemory('zorblax-failover-runbook', shared('failover steps'), fleet, context);
		assert.deepEqual(stored('zorblax-failover-runbook').contentFlag.labels, ['customer:zorblax']);
		await putMemory(
			idFor('clean-v2'),
			shared('failover steps v2', { supersedes: ['zorblax-failover-runbook'] }),
			fleet,
			context,
		);
		assert.deepEqual(stored(idFor('clean-v2')).contentFlag.labels, ['customer:zorblax']);
	});

	it('leaves private, customer-scoped and clean global writes unflagged', async () => {
		await putMemory(idFor('private'), { title: 'p', content: 'Zorblax private' }, fleet, context);
		await putMemory(
			idFor('customer'),
			{ title: 'c', content: 'Zorblax', scopes: ['customer:zorblax'] },
			carol,
			context,
		);
		await putMemory(idFor('clean'), shared('replication lag after compaction'), fleet, context);
		for (const tag of ['private', 'customer', 'clean']) assert.equal(stored(idFor(tag)).contentFlag, null, tag);
	});

	it('does nothing with mode off, and keeps an existing flag enforced', async () => {
		const id = idFor('mode-off');
		await putMemory(id, shared('Zorblax'), fleet, context);
		configure({ mode: 'off' });
		await putMemory(idFor('mode-off-2'), shared('Zorblax again'), fleet, context);
		assert.equal(stored(idFor('mode-off-2')).contentFlag, null);
		await putMemory(id, { content: 'no customer here' }, fleet, ifMatch(1));
		assert.ok(stored(id).contentFlag);
		assert.equal(await getMemory(id, fleet2, context), undefined);
	});

	it('re-checks a revise only when the checked text changes or global is new', async () => {
		const id = idFor('recheck');
		await putMemory(id, shared('Zorblax'), fleet, context);
		const since = stored(id).contentFlag.since;
		await putMemory(id, { validUntil: '2999-01-01T00:00:00Z' }, fleet, ifMatch(1));
		assert.equal(stored(id).contentFlag.since, since);
		await putMemory(id, { content: 'Zorblax and db1.zorbcloud.test' }, fleet, ifMatch(2));
		assert.deepEqual(stored(id).contentFlag.labels, ['customer:zorblax', 'zorb-host']);
		assert.equal(stored(id).contentFlag.since, since);
		await putMemory(id, { content: 'nothing identifying' }, fleet, ifMatch(3));
		assert.equal(stored(id).contentFlag, null);
		assert.equal(stored(id).contentFlagged, null);

		const later = idFor('newly-global');
		await putMemory(later, { title: 'p', content: 'QB Holdings' }, fleet, context);
		await putMemory(later, { visibility: 'shared' }, fleet, ifMatch(1));
		assert.deepEqual(stored(later).contentFlag.labels, ['customer:quintessa']);
	});

	it('flags imported global rows by pattern', async () => {
		const root = createPrincipal({ id: 'root', superUser: true });
		await importMemories(
			{
				rows: [
					{ id: idFor('import-1'), ownerId: 'fleet', title: 't', content: 'Zorblax', scopes: ['global'] },
					{ id: idFor('import-2'), ownerId: 'fleet', title: 't', content: 'Zorblax', scopes: ['user:fleet'] },
				],
			},
			root,
			context,
		);
		assert.deepEqual(stored(idFor('import-1')).contentFlag.labels, ['customer:zorblax']);
		assert.equal(stored(idFor('import-2')).contentFlag, null);
	});
});

describe('the quarantine', () => {
	it('hides a flagged memory from global readers in get, search, pin, citing and candidates: same as missing', async () => {
		const id = idFor('hidden');
		await putMemory(id, shared('Zorblax replication lag on the north cluster'), fleet, context);
		assert.equal(await getMemory(id, fleet2, context), undefined);
		assert.equal(await getMemory(id, carol, context), undefined);
		const params = {
			q: 'replication',
			tags: [],
			scopes: [],
			limit: 10,
			includeSuperseded: false,
			includeExpired: false,
		};
		assert.deepEqual(await searchMemories(params, fleet2, context), []);
		assert.deepEqual(await searchMemories({ ...params, q: undefined }, fleet2, context), []);
		await rejection(pinMemory(id, {}, fleet2, context), 404, 'memory_not_found');
		await rejection(
			putMemory(idFor('citer'), shared('cites it', { evidence: [{ kind: 'memory', ref: id }] }), fleet2, context),
			400,
			'invalid_evidence',
		);
		const { candidates } = await putMemory(
			idFor('similar'),
			shared('replication lag on the north cluster again'),
			fleet2,
			context,
		);
		assert.deepEqual(candidates, []);
	});

	it('shows it to the owner, a customer:* reader with labels, and lists it under flagged=true', async () => {
		const id = idFor('visible');
		await putMemory(id, shared('Zorblax replication lag'), fleet, context);
		assert.ok((await getMemory(id, fleet, context)).contentFlag);
		assert.deepEqual((await getMemory(id, rhea, context)).contentFlag.labels, ['customer:zorblax']);
		await putMemory(idFor('unflagged'), shared('replication lag'), fleet2, context);
		const params = { tags: [], scopes: [], limit: 10, includeSuperseded: false, includeExpired: false, flagged: true };
		const listed = await searchMemories(params, rhea, context);
		assert.deepEqual(
			listed.map((memory) => memory.id),
			[id],
		);
		assert.deepEqual(listed[0].contentFlag.labels, ['customer:zorblax']);
		const hits = await searchMemories({ ...params, flagged: false, q: 'replication' }, rhea, context);
		assert.deepEqual(hits.find((memory) => memory.id === id)?.contentFlag?.labels, ['customer:zorblax']);
		assert.deepEqual(await searchMemories(params, fleet2, context), []);
	});

	it('is applied in every lane before its limit, not by dropping flagged rows from a top-k', async () => {
		for (let i = 0; i < 4; i++)
			await putMemory(idFor(`okapi-${i}`), shared(`Zorblax okapi okapi okapi ${i}`), fleet, context);
		const control = idFor('okapi-ctl');
		await putMemory(control, shared('okapi grazing near the river at dawn'), fleet2, context);
		const base = { tags: [], scopes: [], limit: 1, includeSuperseded: false, includeExpired: false };
		for (const q of ['okapi', undefined]) {
			assert.deepEqual(
				(await searchMemories({ ...base, q }, fleet2, context)).map((memory) => memory.id),
				[control],
				String(q),
			);
		}
	});

	it('hides a review flag whose source is quarantined', async () => {
		const source = idFor('prov-source');
		const citer = idFor('prov-citer');
		await putMemory(source, shared('replication runbook'), fleet, context);
		await putMemory(citer, shared('lesson', { evidence: [{ kind: 'memory', ref: source }] }), fleet2, context);
		await putMemory(source, { content: 'Zorblax replication runbook' }, fleet, ifMatch(1));
		await withdrawMemory(source, {}, fleet, ifMatch(2));
		assert.ok(stored(citer).needsReview);
		assert.equal((await getMemory(citer, fleet2, context)).needsReview, null);
		assert.ok((await getMemory(citer, rhea, context)).needsReview);
	});
});

describe('review', () => {
	it('clears the flag when the owner rescopes out of global', async () => {
		const id = idFor('owner-rescope');
		await putMemory(id, shared('Zorblax'), carol, context);
		await putMemory(id, { scopes: ['customer:zorblax'] }, carol, ifMatch(1));
		assert.equal(stored(id).contentFlag, null);
	});

	it('lets a customer:* writer who can read it move it into customer labels, and nothing else', async () => {
		const id = idFor('reviewer-rescope');
		await putMemory(id, shared('Zorblax'), fleet, context);
		await rejection(putMemory(id, { content: 'edited' }, dave, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(putMemory(id, { scopes: ['customer:zorblax', 'global'] }, dave, ifMatch(1)), 403);
		await rejection(putMemory(id, { scopes: ['team:x'] }, dave, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(putMemory(id, { scopes: ['customer:zorblax'] }, wanda, ifMatch(1)), 409, 'id_unavailable');
		await rejection(putMemory(id, { scopes: ['customer:zorblax'] }, rhea, ifMatch(1)), 403, 'not_memory_owner');
		await rejection(putMemory(id, { scopes: ['customer:zorblax'] }, dave, context), 428, 'if_match_required');

		await putMemory(id, { scopes: ['customer:zorblax'] }, dave, ifMatch(1));
		const row = stored(id);
		assert.deepEqual(row.scopes, ['customer:zorblax']);
		assert.equal(row.ownerId, 'fleet');
		assert.equal(row.lastEditor.principalId, 'dave');
		assert.equal(row.contentFlag, null);
		await rejection(putMemory(id, { scopes: ['customer:quintessa'] }, dave, ifMatch(2)), 403, 'not_memory_owner');
	});

	it("leaves the owner's review flag for the owner", async () => {
		const source = idFor('rescope-source');
		const id = idFor('rescope-citer');
		await putMemory(source, shared('runbook'), fleet2, context);
		await putMemory(id, shared('Zorblax lesson', { evidence: [{ kind: 'memory', ref: source }] }), fleet, context);
		await withdrawMemory(source, {}, fleet2, ifMatch(1));
		assert.ok(stored(id).needsReview);
		await putMemory(id, { scopes: ['customer:zorblax'] }, dave, ifMatch(2));
		assert.ok(stored(id).needsReview);
		assert.equal(stored(id).contentFlag, null);

		const byRoot = idFor('rescope-root');
		await putMemory(byRoot, shared('Zorblax lesson', { evidence: [{ kind: 'memory', ref: id }] }), dave, context);
		await withdrawMemory(id, {}, fleet, ifMatch(3));
		assert.ok(stored(byRoot).needsReview);
		const root = createPrincipal({ id: 'root', superUser: true });
		await putMemory(byRoot, { scopes: ['customer:zorblax'] }, root, ifMatch(2));
		assert.ok(stored(byRoot).needsReview);
	});

	it('lets a reviewer withdraw a flagged replacement that cannot leave global, restoring what it replaced', async () => {
		const runbook = idFor('runbook');
		const replacement = 'zorblax-failover-runbook';
		await putMemory(runbook, shared('failover runbook'), fleet, context);
		await putMemory(replacement, shared('failover runbook v2', { supersedes: [runbook] }), fleet, context);
		assert.ok(stored(replacement).contentFlag);
		assert.equal((await getMemory(runbook, fleet2, context)).supersededBy, null);
		assert.equal((await getMemory(runbook, dave, context)).supersededBy, replacement);

		await rejection(
			putMemory(replacement, { scopes: ['customer:zorblax'] }, dave, ifMatch(1)),
			403,
			'supersede_scope_narrowing',
		);
		await rejection(withdrawMemory(replacement, {}, fleet2, ifMatch(1)), 404, 'memory_not_found');
		await rejection(withdrawMemory(replacement, {}, rhea, ifMatch(1)), 403, 'not_memory_owner');
		await withdrawMemory(replacement, { reason: 'customer detail' }, dave, ifMatch(1));
		assert.equal(stored(runbook).status, 'active');
		const params = { tags: [], scopes: [], limit: 10, includeSuperseded: false, includeExpired: false };
		assert.ok((await searchMemories(params, fleet2, context)).some((memory) => memory.id === runbook));
	});

	it('confirm-scope: a customer:* writer clears it; an uncleared owner cannot', async () => {
		const id = idFor('confirm');
		await putMemory(id, shared('Zorblax'), fleet, context);
		await rejection(confirmScopeMemory(id, {}, fleet, context), 403, 'customer_clearance_required');
		await rejection(confirmScopeMemory(id, {}, fleet2, context), 404, 'memory_not_found');
		await rejection(confirmScopeMemory(id, {}, wanda, context), 404, 'memory_not_found');
		await rejection(confirmScopeMemory(id, {}, dave, ifMatch(9)), 412, 'precondition_failed');

		const memory = await confirmScopeMemory(id, {}, dave, ifMatch(1));
		assert.equal(memory.contentFlag, null);
		assert.equal(memory.scopeConfirmed.by, 'dave');
		assert.equal(memory.revision, 2);
		assert.ok(await getMemory(id, fleet2, context));
		await rejection(confirmScopeMemory(id, {}, dave, context), 409, 'not_flagged');
	});

	it('confirm-scope needs customer:* read as well as write, even from the owner', async () => {
		const id = idFor('confirm-own');
		await putMemory(id, shared('Zorblax'), wanda, context);
		await rejection(confirmScopeMemory(id, {}, wanda, context), 403, 'customer_clearance_required');
		assert.ok(stored(id).contentFlag);
	});

	it('binds a confirmation to the text it reviewed', async () => {
		const id = idFor('confirm-bind');
		await putMemory(id, shared('Zorblax'), fleet, context);
		await confirmScopeMemory(id, {}, dave, context);
		await putMemory(id, { validUntil: '2999-01-01T00:00:00Z' }, fleet, ifMatch(2));
		assert.equal(stored(id).contentFlag, null);
		assert.equal(stored(id).scopeConfirmed.by, 'dave');
		await putMemory(id, { content: 'Zorblax production password rotation' }, fleet, ifMatch(3));
		assert.deepEqual(stored(id).contentFlag.labels, ['customer:zorblax']);
		assert.equal(stored(id).scopeConfirmed, null);
		await confirmScopeMemory(id, {}, dave, context);
		await putMemory(id, { content: 'Zorblax and db1.zorbcloud.test' }, fleet, ifMatch(5));
		assert.deepEqual(stored(id).contentFlag.labels, ['customer:zorblax', 'zorb-host']);
	});

	it('keeps a confirmation across an evidence change the check does not read', async () => {
		const id = idFor('confirm-kind');
		await putMemory(id, shared('Zorblax', { evidence: [{ kind: 'doc', ref: 'runbook.md' }] }), fleet, context);
		await confirmScopeMemory(id, {}, dave, context);
		await putMemory(id, { evidence: [{ kind: 'url', ref: 'runbook.md' }] }, fleet, ifMatch(2));
		assert.equal(stored(id).contentFlag, null);
		assert.equal(stored(id).scopeConfirmed.by, 'dave');
	});

	it('leaves the flag alone on status-only writes', async () => {
		const id = idFor('status-only');
		await putMemory(id, shared('Zorblax'), fleet, context);
		await confirmMemory(id, {}, fleet, context);
		assert.ok(stored(id).contentFlag);
		const tombstone = await withdrawMemory(id, {}, fleet, ifMatch(2));
		assert.ok(stored(id).contentFlag);
		assert.equal(tombstone.contentFlag.labels, undefined);
		await rejection(confirmScopeMemory(id, {}, dave, context), 404, 'memory_not_found');
	});
});

describe('the model check', () => {
	const deferred = () => {
		let resolve;
		const promise = new Promise((done) => (resolve = done));
		return { promise, resolve };
	};

	it('flags after commit, without holding up the write', async () => {
		configure({ model: 'content-stub' });
		const pending = deferred();
		models.generator = () => pending.promise;
		const id = idFor('model-flag');
		const { memory } = await putMemory(id, shared('the acme cluster in frankfurt'), fleet, context);
		assert.equal(memory.contentFlag, null);
		assert.equal(models.generateCalls.length, 1);
		assert.equal(models.generateCalls[0].options.model, 'content-stub');
		pending.resolve('customer');
		await eventually(() => stored(id).contentFlag);
		assert.equal(stored(id).contentFlag.source, 'model');
		assert.equal(stored(id).lastEventKind, 'flagged');
		assert.equal(stored(id).revision, 2);
		assert.equal(await getMemory(id, fleet2, context), undefined);
	});

	it('is not asked when the patterns already flagged, when the text is unchanged, or for a private write', async () => {
		configure({ model: 'content-stub' });
		models.generator = () => 'clean';
		await putMemory(idFor('model-skip-1'), shared('Zorblax'), fleet, context);
		await putMemory(idFor('model-skip-2'), { title: 'p', content: 'private' }, fleet, context);
		await putMemory(idFor('model-skip-3'), shared('clean text'), fleet, context);
		await settle();
		await putMemory(idFor('model-skip-3'), { validUntil: '2999-01-01T00:00:00Z' }, fleet, ifMatch(1));
		await settle();
		assert.equal(models.generateCalls.length, 1);
	});

	it('keeps a flag the patterns no longer support until the model clears it', async () => {
		configure({ model: 'content-stub' });
		models.generator = () => 'clean';
		const id = idFor('model-clear');
		await putMemory(id, shared('Zorblax'), fleet, context);
		const pending = deferred();
		models.generator = () => pending.promise;
		await putMemory(id, { content: 'rewritten without names' }, fleet, ifMatch(1));
		assert.ok(stored(id).contentFlag);
		assert.equal(stored(id).contentFlag.labels, undefined);
		pending.resolve('clean');
		await eventually(() => stored(id).contentFlag === null);
		assert.ok(await getMemory(id, fleet2, context));
	});

	it('takes over a kept pattern flag when it answers customer', async () => {
		configure({ model: 'content-stub' });
		const id = idFor('model-takeover');
		await putMemory(id, shared('Zorblax'), fleet, context);
		const pending = deferred();
		models.generator = () => pending.promise;
		await putMemory(id, { content: 'the frankfurt cluster of a bank' }, fleet, ifMatch(1));
		const since = stored(id).contentFlag.since;
		pending.resolve('customer');
		await eventually(() => stored(id).contentFlag.source === 'model');
		assert.deepEqual(stored(id).contentFlag, { kind: 'possible-customer-detail', since, source: 'model' });
	});

	it('drops a verdict given under configuration that has since been reloaded', async () => {
		configure({ model: 'content-stub' });
		const pending = deferred();
		models.generator = () => pending.promise;
		const id = idFor('model-reloaded');
		await putMemory(id, shared('plain text'), fleet, context);
		configure({ model: 'content-stub' });
		pending.resolve('customer');
		await settle();
		assert.equal(stored(id).contentFlag, null);
	});

	it('drops a verdict about text or a review state that has since changed', async () => {
		configure({ model: 'content-stub' });
		const first = deferred();
		models.generator = () => first.promise;
		const edited = idFor('model-stale-1');
		await putMemory(edited, shared('first text'), fleet, context);
		models.generator = () => 'clean';
		await putMemory(edited, { content: 'second text' }, fleet, ifMatch(1));
		first.resolve('customer');
		await settle();
		assert.equal(stored(edited).contentFlag, null);

		models.generator = () => 'clean';
		const reviewed = idFor('model-stale-2');
		await putMemory(reviewed, shared('Zorblax'), fleet, context);
		const pending = deferred();
		models.generator = () => pending.promise;
		await putMemory(reviewed, { content: 'rewritten' }, fleet, ifMatch(1));
		await confirmScopeMemory(reviewed, {}, dave, context);
		pending.resolve('customer');
		await settle();
		assert.equal(stored(reviewed).contentFlag, null);
		assert.equal(stored(reviewed).scopeConfirmed.by, 'dave');
	});

	it('holds its slot until the provider call ends, even after the deadline', async () => {
		configure({ model: 'content-stub' });
		mock.timers.enable({ apis: ['setTimeout'] });
		const pendings = [];
		models.generator = () => {
			const pending = deferred();
			pendings.push(pending);
			return pending.promise;
		};
		try {
			for (let i = 0; i < 8; i++) await putMemory(idFor(`deadline-${i}`), shared(`text ${i}`), fleet, context);
			mock.timers.tick(30_000);
			await new Promise(setImmediate);
			await putMemory(idFor('deadline-9'), shared('text 9'), fleet, context);
			assert.equal(models.generateCalls.length, 8);
			assert.ok(models.generateCalls.every(({ options }) => options.signal.aborted));
			for (const pending of pendings) pending.resolve('clean');
			await new Promise(setImmediate);
			await putMemory(idFor('deadline-10'), shared('text 10'), fleet, context);
			assert.equal(models.generateCalls.length, 9);
			pendings.at(-1).resolve('clean');
		} finally {
			mock.timers.reset();
		}
	});

	it('skips checks past the in-flight cap, and survives a failing backend and a failing sink', async () => {
		configure({ model: 'content-stub' });
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		const pendings = [];
		models.generator = () => {
			const pending = deferred();
			pendings.push(pending);
			return pending.promise;
		};
		try {
			for (let i = 0; i < 9; i++) await putMemory(idFor(`cap-${i}`), shared(`text ${i}`), fleet, context);
			assert.equal(models.generateCalls.length, 8);
			for (const pending of pendings) pending.resolve('clean');
			await settle();

			models.generator = () => {
				throw new Error('backend down: the acme cluster');
			};
			await putMemory(idFor('model-throws'), shared('text'), fleet, context);
			const unregister = registerMemorySink({
				write(memory) {
					if (memory.contentFlag) throw new Error('sink rejected');
				},
			});
			models.generator = () => 'customer';
			await putMemory(idFor('model-sink'), shared('text'), fleet, context);
			await settle();
			unregister();
			assert.equal(stored(idFor('model-sink')).contentFlag, null);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		assert.deepEqual(unhandled, []);
	});
});

describe('events', () => {
	const fleetUser = { username: 'fleet' };
	const ownerUser = { username: 'owner' };
	const target = (params = {}) => Object.assign(new URLSearchParams(''), params);

	function collect(stream) {
		const received = [];
		const done = (async () => {
			for await (const event of stream) received.push(event);
		})();
		return {
			received,
			async close() {
				stream.end();
				await done;
			},
		};
	}

	beforeEach(async () => {
		await databases.memory.ScopeGrant.put({ id: 'user:fleet', read: ['global'], write: ['global'] });
		await databases.memory.ScopeGrant.put({ id: 'user:owner', read: ['global'], write: ['global'] });
	});

	it('delivers a content flag to the owner on /MemoryEvents and nothing to a global reader', async () => {
		configure({ model: 'content-stub' });
		models.generator = () => 'customer';
		const ownerEvents = collect(await MemoryEventsResource.subscribe(target(), { user: ownerUser }));
		const fleetRecords = collect(await MemoryResource.subscribe(target({ rest: '' }), { user: fleetUser }));
		const byPattern = idFor('event-pattern');
		const byModel = idFor('event-model');
		await MemoryItemResource.put(target({ id: byPattern }), shared('Zorblax'), { user: ownerUser });
		await MemoryItemResource.put(target({ id: byModel }), shared('unremarkable'), { user: ownerUser });
		await eventually(() => ownerEvents.received.length >= 2);
		await settle();
		await ownerEvents.close();
		await fleetRecords.close();
		assert.deepEqual(
			ownerEvents.received.map(({ id, kind }) => [id, kind]),
			[
				[byPattern, 'created'],
				[byModel, 'flagged'],
			],
		);
		assert.deepEqual(
			fleetRecords.received.map(({ id, kind }) => [id, kind]),
			[[byModel, 'created']],
		);
	});

	it('tells the owner when a revise newly flags a memory, not about every edit of a flagged one', async () => {
		const ownerEvents = collect(await MemoryEventsResource.subscribe(target(), { user: ownerUser }));
		const id = idFor('event-revise');
		const put = (input, revision) =>
			MemoryItemResource.put(target({ id }), input, {
				user: ownerUser,
				...(revision && { headers: { 'if-match': `"${revision}"` } }),
			});
		// Apart by more than a millisecond: `since` and the revise's own timestamp share that resolution.
		for (const [input, revision] of [
			[shared('clean text')],
			[{ content: 'QB Holdings text' }, 1],
			[{ validUntil: '2999-01-01T00:00:00Z' }, 2],
			[{ content: 'QB Holdings text, edited' }, 3],
		]) {
			await put(input, revision);
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		await eventually(() => ownerEvents.received.length >= 1);
		await settle();
		await ownerEvents.close();
		assert.deepEqual(
			ownerEvents.received.map(({ id: eventId, kind, revision }) => [eventId, kind, revision]),
			[[id, 'revised', 2]],
		);
	});
});
