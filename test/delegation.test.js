import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases } from 'harper';
import {
	MemoryActionResource,
	MemoryBootstrapResource,
	MemoryEventsResource,
	MemoryItemResource,
	MemoryMcpResource,
	MemoryResource,
} from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

// kris is the person; agent-a and agent-b are kris's agents (global only); carol is someone else.
const kris = { username: 'kris' };
const agentA = { username: 'agent-a' };
const agentB = { username: 'agent-b' };
const cleared = { username: 'agent-c' };
const carol = { username: 'carol' };
const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };

const target = (query = '', params = {}) => Object.assign(new URLSearchParams(query), params);
const ctx = (user, revision) => ({ user, ...(revision !== undefined && { headers: { 'if-match': `"${revision}"` } }) });
const parse = async (response) => ({ status: response.status, body: await response.json() });
const stored = (id) => __test.stores.get('Memory').get(id);

const grant = (id, read, write) => databases.memory.ScopeGrant.put({ id, read, write });
const delegate = (id, actsFor) => databases.memory.Delegation.put({ id, actsFor });
const revoke = (id) => databases.memory.Delegation.delete(id);

const put = async (user, id, body, revision) =>
	parse(await MemoryItemResource.put(target('', { id }), body, ctx(user, revision)));
const get = async (user, id) => parse(await MemoryItemResource.get(target('', { id }), ctx(user)));
const withdraw = async (user, id, revision) =>
	parse(await MemoryItemResource.delete(target('', { id }), ctx(user, revision)));
const act = async (user, id, action, body = {}, revision) =>
	parse(await MemoryActionResource.post(target('', { id, action }), body, ctx(user, revision)));
const candidates = async (user, id) =>
	parse(await MemoryActionResource.get(target('', { id, action: 'candidates' }), ctx(user)));
const search = async (user, query = '') => parse(await MemoryResource.get(target(query, { rest: '' }), ctx(user)));
const bootstrap = async (user) =>
	parse(await MemoryBootstrapResource.get(target('budget=100000', { rest: '' }), ctx(user)));
const note = (title, extra = {}) => ({ title, content: `${title} body`, ...extra });
const idOf = (tag) => `mem-dlg-${tag}`.padEnd(16, '_');

function collectEvents(stream) {
	const received = [];
	const done = (async () => {
		for await (const event of stream) received.push(event);
	})();
	return {
		received,
		async settle(ms = 30) {
			await new Promise((resolve) => setTimeout(resolve, ms));
		},
		async close() {
			stream.end();
			await done;
		},
	};
}

beforeEach(async () => {
	__test.reset();
	applySettings(parseSettings({ mcp: true }));
	await grant('user:kris', ['global', 'customer:*'], ['global', 'customer:*']);
	await grant('user:agent-a', ['global'], ['global']);
	await grant('user:agent-b', ['global'], ['global']);
	await grant('user:agent-c', ['global', 'customer:*'], ['global', 'customer:*']);
	await grant('user:carol', ['global'], ['global']);
	await delegate('agent-a', 'kris');
	await delegate('agent-b', 'kris');
	await delegate('agent-c', 'kris');
});

describe('delegated edit', () => {
	it("revises, confirms and withdraws the principal's memory as the principal would, recording the delegate", async () => {
		const id = idOf('edit');
		assert.equal((await put(kris, id, note('imported finding', { visibility: 'shared' }))).status, 201);

		const revised = await put(agentA, id, { content: 'corrected by agent-a' }, 1);
		assert.equal(revised.status, 200, JSON.stringify(revised.body));
		assert.equal(stored(id).ownerId, 'kris');
		assert.equal(stored(id).content, 'corrected by agent-a');
		assert.equal(stored(id).lastEditor.principalId, 'agent-a');

		const confirmed = await act(agentB, id, 'confirm', {}, 2);
		assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
		assert.equal(stored(id).confirmed.by, 'agent-b');
		assert.equal(stored(id).lastEditor.principalId, 'agent-a');

		const withdrawn = await withdraw(agentA, id, 3);
		assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		assert.equal(withdrawn.body.memory.withdrawnBy, 'agent-a');
		assert.equal(stored(id).status, 'withdrawn');
		assert.equal(stored(id).ownerId, 'kris');
		assert.equal(stored(id).withdrawnBy, 'agent-a');
		assert.equal(stored(id).lastEditor.principalId, 'agent-a');
		// Withdrawn memories stay readable by their owner only: a delegate reads through labels.
		assert.equal((await get(kris, id)).status, 200);
		assert.equal((await get(agentA, id)).status, 404);
	});

	it("links and lists candidates for the principal's memories", async () => {
		const older = idOf('older');
		const newer = idOf('newer');
		await put(kris, older, note('older', { visibility: 'shared' }));
		await put(kris, newer, note('newer', { visibility: 'shared' }));
		assert.equal((await candidates(agentA, newer)).status, 200);
		const linked = await act(agentA, newer, 'supersedes', { ids: [older] }, 1);
		assert.equal(linked.status, 200, JSON.stringify(linked.body));
		assert.equal(stored(older).supersededBy, newer);
		assert.equal(stored(newer).ownerId, 'kris');
	});

	it('refuses a principal without the row as before, and a revoked row from the next request', async () => {
		const id = idOf('revoke');
		await put(kris, id, note('shared note', { visibility: 'shared' }));
		assert.equal((await put(carol, id, { content: 'carol' }, 1)).status, 403);
		assert.equal((await withdraw(carol, id, 1)).status, 403);
		assert.equal((await act(carol, id, 'confirm')).status, 403);
		assert.equal((await candidates(carol, id)).status, 403);

		assert.equal((await put(agentA, id, { content: 'before revoke' }, 1)).status, 200);
		await revoke('agent-a');
		const refused = await put(agentA, id, { content: 'after revoke' }, 2);
		assert.equal(refused.status, 403);
		assert.equal(refused.body.code, 'not_memory_owner');
		assert.equal((await withdraw(agentA, id, 2)).status, 403);
		assert.equal(stored(id).content, 'before revoke');
	});

	it('does not reach a principal two delegations away', async () => {
		await delegate('kris', 'boss');
		const id = idOf('chain');
		await put(superUser, id, note('boss note', { scopes: ['user:boss'] }));
		await databases.memory.Memory.patch(id, { ownerId: 'boss' });
		assert.equal((await get(kris, id)).status, 200);
		assert.equal((await get(agentA, id)).status, 404);
		assert.equal((await put(agentA, id, { content: 'x' }, 1)).status, 409);
	});
});

describe("the principal's private scope", () => {
	it("lands a delegate's private write in user:<principal>, owned by the principal and editable by its delegates", async () => {
		const implicit = idOf('implicit');
		const explicit = idOf('explicit');
		assert.equal((await put(agentA, implicit, note('agent note'))).status, 201);
		assert.equal((await put(agentA, explicit, note('agent private', { visibility: 'private' }))).status, 201);
		for (const id of [implicit, explicit]) {
			assert.deepEqual(stored(id).scopes, ['user:kris']);
			assert.equal(stored(id).ownerId, 'kris');
			assert.equal(stored(id).author.principalId, 'agent-a');
		}
		// An identical retry by the writer is still a retry.
		assert.equal((await put(agentA, implicit, note('agent note'))).status, 200);

		assert.equal((await get(agentB, implicit)).status, 200);
		assert.equal((await get(kris, implicit)).status, 200);
		assert.equal((await get(carol, implicit)).status, 404);
		assert.equal((await put(carol, implicit, { content: 'carol' }, 1)).status, 409);
		assert.equal((await withdraw(carol, implicit, 1)).status, 404);

		assert.equal((await put(agentB, implicit, { content: 'agent-b edit' }, 1)).status, 200);
		assert.equal((await put(kris, implicit, { content: 'kris edit' }, 2)).status, 200);
		// A private shorthand on the principal's memory keeps resolving against the owner.
		assert.equal((await put(agentB, explicit, { visibility: 'private', title: 'renamed' }, 1)).status, 200);
		assert.deepEqual(stored(explicit).scopes, ['user:kris']);

		const ids = (response) => response.body.memories.map((memory) => memory.id).sort();
		assert.deepEqual(ids(await search(agentB)), [explicit, implicit].sort());
		assert.deepEqual(ids(await search(kris)), [explicit, implicit].sort());
		assert.deepEqual(ids(await search(carol)), []);
	});

	it("keeps a delegate's shared, mixed and own-private creates its own", async () => {
		const shared = idOf('shared');
		const mixed = idOf('mixed');
		const own = idOf('own');
		assert.equal((await put(agentA, shared, note('shared', { visibility: 'shared' }))).status, 201);
		assert.equal((await put(agentA, mixed, note('mixed', { scopes: ['user:kris', 'global'] }))).status, 201);
		assert.equal((await put(agentA, own, note('own', { scopes: ['user:agent-a'] }))).status, 201);
		assert.equal(stored(shared).ownerId, 'agent-a');
		assert.equal(stored(mixed).ownerId, 'agent-a');
		assert.deepEqual(stored(own).scopes, ['user:agent-a']);
		assert.equal(stored(own).ownerId, 'agent-a');
		assert.equal((await get(agentB, own)).status, 404);
		assert.equal((await put(agentB, mixed, { content: 'agent-b' }, 1)).status, 403);
	});

	it('loses user:<principal> with the row', async () => {
		const id = idOf('private-revoke');
		await put(agentB, id, note('family note'));
		assert.equal((await get(agentA, id)).status, 200);
		await revoke('agent-a');
		assert.equal((await get(agentA, id)).status, 404);
		assert.equal(
			(await put(agentA, idOf('after'), note('x', { scopes: ['user:kris'] }))).body.code,
			'scope_not_writable',
		);
	});
});

describe('labels stay gated by the delegate’s own grants', () => {
	it("denies a global-only delegate the principal's customer memory everywhere", async () => {
		const id = idOf('customer');
		await put(kris, id, note('acme incident', { scopes: ['customer:acme'] }));
		await put(kris, idOf('replacement'), note('replacement', { scopes: ['customer:acme'] }));
		assert.equal((await get(agentA, id)).status, 404);
		assert.equal((await put(agentA, id, { content: 'x' }, 1)).status, 409);
		assert.equal((await withdraw(agentA, id, 1)).status, 404);
		assert.equal((await act(agentA, id, 'confirm')).status, 404);
		assert.equal((await candidates(agentA, id)).status, 404);
		assert.equal((await act(agentA, idOf('replacement'), 'supersedes', { ids: [id] }, 1)).status, 404);
		assert.deepEqual((await search(agentA)).body.memories, []);
		assert.equal((await get(cleared, id)).status, 200);
		assert.equal((await put(cleared, id, { content: 'cleared edit' }, 1)).status, 200);
	});

	it('hides a content-flagged memory of the principal from an uncleared delegate', async () => {
		applySettings(
			parseSettings({
				mcp: true,
				customerContentCheck: { patterns: { hosts: [{ label: 'acme-db', host: 'db.acme.test' }] } },
			}),
		);
		const id = idOf('flagged');
		await put(kris, id, note('outage on db.acme.test', { visibility: 'shared' }));
		assert.ok(stored(id).contentFlag);
		assert.equal((await get(agentA, id)).status, 404);
		assert.equal((await put(agentA, id, { content: 'scrubbed' }, 1)).status, 409);
		assert.equal((await get(cleared, id)).status, 200);
	});
});

describe('refusal guidance', () => {
	it('names the supersede route on the revise 403, over HTTP and MCP', async () => {
		const id = idOf('guidance');
		await put(kris, id, note('kris note', { visibility: 'shared' }));
		const refused = await put(carol, id, { content: 'carol edit' }, 1);
		assert.equal(refused.status, 403);
		assert.match(refused.body.error, new RegExp(`supersedes: \\["${id}"\\]`));

		const resource = new MemoryMcpResource();
		await assert.rejects(
			() => resource.mcpRevise({ id, revision: 1, content: 'carol edit' }, { user: carol }),
			(error) => error.statusCode === 403 && error.code === 'not_memory_owner' && error.message.includes(id),
		);
		const revise = MemoryMcpResource.mcpTools.find((tool) => tool.name === 'revise');
		assert.match(revise.description, /supersedes/);
		assert.deepEqual(await resource.mcpRevise({ id, revision: 1, content: 'agent edit' }, { user: agentA }), {
			id,
			revision: 2,
			created: false,
			candidates: [],
			scopes: ['global'],
			status: 'active',
			contentFlag: null,
			needsReview: null,
		});
	});
});

describe("a delegate's own view", () => {
	it("bootstraps the principal's private notes beside the delegate's own, not the principal's shared corpus", async () => {
		await put(kris, idOf('corpus'), note('imported shared', { visibility: 'shared' }));
		await put(agentB, idOf('family'), note('family private note'));
		await put(agentA, idOf('mine'), note('agent-a shared', { visibility: 'shared' }));
		const recent = (await bootstrap(agentA)).body.memories
			.filter((memory) => memory.section === 'recent')
			.map((memory) => memory.id)
			.sort();
		assert.deepEqual(recent, [idOf('family'), idOf('mine')].sort());
		const carolRecent = (await bootstrap(carol)).body.memories.filter((memory) => memory.section === 'recent');
		assert.deepEqual(carolRecent, []);
	});

	it("lists the principal's flagged private notes for review and delivers their flag events", async () => {
		const source = idOf('source');
		const citer = idOf('citer');
		await put(kris, source, note('source', { visibility: 'shared' }));
		await put(agentB, citer, note('private conclusion', { evidence: [{ kind: 'memory', ref: source }] }));
		const events = collectEvents(await MemoryEventsResource.connect(target(''), null, ctx(agentA)));
		await withdraw(kris, source, 1);
		await events.settle();
		await events.close();
		assert.deepEqual(events.received, [{ id: citer, kind: 'flagged', revision: 2 }]);
		const review = (await bootstrap(agentA)).body.memories.filter((memory) => memory.section === 'needsReview');
		assert.deepEqual(
			review.map((memory) => memory.id),
			[citer],
		);
	});

	it('stops live events for user:<principal> once the row is revoked', async () => {
		const id = idOf('live');
		const events = collectEvents(await MemoryResource.subscribe(target('', { rest: '' }), ctx(agentA)));
		await put(kris, id, note('kris private'));
		await events.settle();
		await revoke('agent-a');
		await events.settle();
		await put(kris, id, { content: 'kris private v2' }, 1);
		await events.settle();
		await events.close();
		assert.deepEqual(events.received, [{ id, kind: 'created', revision: 1 }]);
	});
});

describe('subscriber principal cache', () => {
	it('does not cache a resolution that started before a grant change', async () => {
		await grant('user:carol', ['global', 'team:eng'], ['global']);
		await grant('user:kris', ['global', 'team:eng'], ['global', 'team:eng']);
		const ScopeGrant = databases.memory.ScopeGrant;
		const originalGet = ScopeGrant.get;
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let armed = false;
		let held = false;
		ScopeGrant.get = async function (id, context) {
			const row = await originalGet.call(this, id, context);
			if (armed && id === 'user:carol' && !held) {
				held = true;
				await gate;
			}
			return row;
		};
		try {
			const id = idOf('fence');
			const events = collectEvents(await MemoryResource.subscribe(target('', { rest: '' }), ctx(carol)));
			armed = true;
			await put(kris, id, note('team note', { scopes: ['team:eng'] }));
			await events.settle();
			assert.ok(held, 'delivery should be resolving carol');
			await grant('user:carol', ['global'], ['global']);
			await events.settle();
			release();
			await events.settle();
			await put(kris, id, { content: 'team note v2' }, 1);
			await events.settle();
			await events.close();
			assert.ok(!events.received.some((event) => event.revision === 2), JSON.stringify(events.received));
		} finally {
			ScopeGrant.get = originalGet;
			release();
		}
	});
});
