// A second copy of the package, loaded from another path, stands for an app that imports @harperfast/agent-memory
// from its own node_modules while the plugin runs in another app. The tests share one process-wide registry, so
// they run in order and build on each other.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __test, databases, logger, resources } from 'harper';
import * as plugin from '../dist/index.js';
import { putMemory, withdrawMemory } from '../dist/lifecycle.js';
import { resolvePrincipal as pluginResolvePrincipal } from '../dist/principal.js';
import { MemoryMcpResource, MemoryResource } from '../dist/resource.js';
import { domain } from '../dist/runtime.js';
import { canReadLabels as pluginCanReadLabels } from '../dist/scopes.js';
import { bootstrapMemories, scanMemories as pluginScanMemories } from '../dist/search.js';

const ANCHOR = Symbol.for('@harperfast/agent-memory');
const stubUrl = new URL('./helpers/harper-stub.mjs', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'agent-memory-copies-'));

// Each copy is dist/ and package.json under its own directory. A copy listed in `harperFor` imports a wrapper of
// the stub in place of `harper`, overriding the export a Harper module loader would bind differently.
const harperFor = {
	candidate: 'export const resources = new Map();',
	invalid: null,
	branch: 'export const databases = { memory: stub.databases.memory };',
	unscoped: 'export const resources = undefined;',
};
const wrappers = {};
for (const [name, override] of Object.entries(harperFor)) {
	if (override === null) continue;
	const file = join(root, `harper-${name}.mjs`);
	writeFileSync(
		file,
		`import * as stub from ${JSON.stringify(stubUrl)};\nexport * from ${JSON.stringify(stubUrl)};\n${override}\n`,
	);
	wrappers[name] = pathToFileURL(file).href;
}
// `invalid` shares the candidate's domain, so it can show a failed load leaves that domain without a runtime.
wrappers.invalid = wrappers.candidate;

const copyDir = (name) => join(root, name);
const routes = Object.fromEntries(
	Object.keys(wrappers).map((name) => [pathToFileURL(copyDir(name)).href + '/', wrappers[name]]),
);
register(
	`data:text/javascript,${encodeURIComponent(`
const routes = ${JSON.stringify(routes)};
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'harper' && context.parentURL) {
		for (const [prefix, url] of Object.entries(routes)) {
			if (context.parentURL.startsWith(prefix)) return { url, format: 'module', shortCircuit: true };
		}
	}
	return nextResolve(specifier, context);
}
`)}`,
	import.meta.url,
);

async function loadCopy(name, version) {
	const dir = copyDir(name);
	cpSync(new URL('../dist', import.meta.url), join(dir, 'dist'), { recursive: true });
	cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
	if (version) writeFileSync(join(dir, 'dist', 'version.js'), `export const PACKAGE_VERSION = '${version}';\n`);
	return import(pathToFileURL(join(dir, 'dist', 'index.js')).href);
}

function fakeScope(options, { isTransientValidation = false } = {}) {
	const entries = new Map();
	const watcher = new EventEmitter();
	watcher.getAll = () => options;
	return {
		entries,
		scope: {
			isTransientValidation,
			options: watcher,
			logger: { error() {}, warn() {} },
			resources: {
				set: (path, Resource) => entries.set(path, { Resource, path }),
				get: (path) => entries.get(path),
				delete: (path) => entries.delete(path),
			},
		},
	};
}

const member = (username) => ({ user: { username, role: { role: 'agents', permission: {} } } });
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const ifMatch = (revision) => ({ headers: { 'if-match': `"${revision}"` } });
const input = (content) => ({ title: 'Cross-app note', content, visibility: 'shared' });
const isResourceShaped = (value) =>
	Boolean(value) && ['get', 'put', 'post', 'delete'].some((verb) => typeof value[verb] === 'function');

const warnings = [];
const originalWarn = logger.warn;
let copy, candidate, invalid, branch, unscoped, skewed;
let resolverCalls = 0;
let earlyPrincipal;

before(async () => {
	logger.warn = (...args) => warnings.push(args.join(' '));
	copy = await loadCopy('copy');
	candidate = await loadCopy('candidate');
	invalid = await loadCopy('invalid');
	branch = await loadCopy('branch');
	unscoped = await loadCopy('unscoped');
	skewed = await loadCopy('skewed', '1.0.0');
});

after(() => {
	logger.warn = originalWarn;
	rmSync(root, { recursive: true, force: true });
});

describe('a second copy of the package', () => {
	it('is side-effect free to import: no registry, no rows, nothing a host would mount as a resource', () => {
		assert.equal(Object.hasOwn(process, ANCHOR), false);
		for (const [name, rows] of __test.stores) assert.equal(rows.size, 0, `${name} has rows`);
		assert.equal(resources.size, 0);
		for (const namespace of [plugin, copy, candidate, branch, unscoped, skewed]) {
			for (const [name, value] of Object.entries(namespace)) {
				assert.equal(isResourceShaped(value), false, `export ${name} looks like a Resource`);
			}
		}
	});

	it('resolves principals with its own code while no plugin runs', async () => {
		await databases.memory.ScopeGrant.put({ id: 'role:agents', read: ['global'], write: ['global'] });
		earlyPrincipal = await copy.resolvePrincipal(member('alice'));
		assert.equal(copy.canReadLabels(earlyPrincipal, ['global']), true);
		assert.throws(() => pluginCanReadLabels(earlyPrincipal, ['global']), TypeError);
	});

	it('scans with its own code, and holds a section and an annotator registered before any plugin loads', async () => {
		const scan = copy.scanMemories();
		assert.notEqual(Object.getPrototypeOf(scan), pluginScanMemories.prototype);
		for await (const _row of scan);
		copy.registerBootstrapSection({
			name: 'early',
			render: ({ principal }) => [{ content: `early for ${principal.id}` }],
		});
		copy.registerSearchAnnotator({
			name: 'earlyNote',
			annotate: ({ hits }) => new Map(hits.map((hit) => [hit.id, 'early'])),
		});
		assert.equal(warnings.length, 0);
	});

	it('reaches the plugin with a sink and a resolver registered before the plugin loads', async () => {
		const calls = [];
		copy.registerMemorySink({
			write: (memory, context) => calls.push(['write', memory.id, memory.revision, Boolean(context.transaction)]),
			withdraw: (memory, context) => calls.push(['withdraw', memory.id, memory.status, Boolean(context.transaction)]),
		});
		copy.setPrincipalResolver((context, next) => {
			resolverCalls++;
			return context.user?.username === 'erin'
				? { id: 'agent-erin', grants: { read: ['global'], write: ['global'] }, source: 'copy-resolver' }
				: next();
		});
		// Registered before the plugin publishes, so the plugin warns when it does (and `unscoped` stays private).
		const unscopedCalls = [];
		unscoped.registerMemorySink({ write: (memory) => unscopedCalls.push(memory.id) });

		await plugin.handleApplication(fakeScope({}).scope);

		const alice = await pluginResolvePrincipal(member('alice'));
		const id = idFor('reach');
		await putMemory(id, input('first'), alice, {});
		await putMemory(id, input('second'), alice, ifMatch(1));
		await withdrawMemory(id, {}, alice, ifMatch(2));
		assert.deepEqual(calls, [
			['write', id, 1, true],
			['write', id, 2, true],
			['withdraw', id, 'withdrawn', true],
		]);
		assert.deepEqual(unscopedCalls, []);

		const erin = await pluginResolvePrincipal(member('erin'));
		assert.deepEqual([erin.id, erin.source], ['agent-erin', 'copy-resolver']);
		assert.deepEqual(
			warnings.filter((line) => line.includes("loaded without its app's scope")),
			[warnings[0]],
		);
		assert.equal(warnings.length, 1);
	});

	it('answers resolvePrincipal and canReadLabels with the plugin', async () => {
		const before = resolverCalls;
		const viaCopy = await copy.resolvePrincipal(member('alice'));
		assert.equal(resolverCalls, before + 1);
		assert.equal(pluginCanReadLabels(viaCopy, ['global']), true);
		assert.throws(() => pluginCanReadLabels(earlyPrincipal, ['global']), TypeError);

		const viaPlugin = await pluginResolvePrincipal(member('alice'));
		assert.equal(copy.canReadLabels(viaPlugin, ['global']), true);
		assert.equal(copy.canReadLabels(viaPlugin, ['team:z']), false);
		assert.equal(copy.canReadLabels(earlyPrincipal, ['global']), true);
		for (const forged of [
			JSON.parse(JSON.stringify(viaPlugin)),
			{ ...viaPlugin },
			Object.create(viaPlugin),
			structuredClone(viaPlugin),
		]) {
			assert.throws(() => copy.canReadLabels(forged, ['global']), TypeError);
		}
		await assert.rejects(
			copy.resolvePrincipal({}),
			(error) => error.statusCode === 401 && error.code === 'principal_required',
		);
	});

	it("uses the copy's sections and annotators in the plugin's bootstrap and search, and scans through the plugin", async () => {
		const unregisterSection = copy.registerBootstrapSection({
			name: 'late',
			render: ({ budgetChars }) => ({ text: `late with ${budgetChars}` }),
		});
		const unregisterAnnotator = copy.registerSearchAnnotator({
			name: 'lateNote',
			annotate: ({ principal, hits }) =>
				new Map(hits.map((hit) => [hit.id, { by: principal.id, readable: copy.canReadLabels(principal, hit.scopes) }])),
		});
		const alice = await pluginResolvePrincipal(member('alice'));
		const id = idFor('annotated');
		await putMemory(id, input('kestrel hovering'), alice, {});

		const booted = await bootstrapMemories({ budget: 8000 }, alice, {});
		assert.deepEqual(
			booted.memories.filter((entry) => entry.id === undefined).map((entry) => [entry.section, entry.content]),
			[
				['early', 'early for alice'],
				['late', 'late with 8000'],
			],
		);

		const response = await MemoryResource.get(new URLSearchParams('q=kestrel'), member('alice'));
		const [hit] = (await response.json()).memories;
		assert.equal(hit.id, id);
		assert.equal(hit.earlyNote, 'early');
		assert.deepEqual(hit.lateNote, { by: 'alice', readable: true });
		const recalled = await new MemoryMcpResource().mcpRecall({ q: 'kestrel' }, member('alice'));
		assert.deepEqual(recalled.memories[0].lateNote, { by: 'alice', readable: true });

		const scan = copy.scanMemories();
		assert.equal(Object.getPrototypeOf(scan), pluginScanMemories.prototype);
		const rows = [];
		for await (const row of scan) rows.push(row);
		assert.ok(rows.some((row) => row.id === id && Array.isArray(row.embedding)));
		const resumed = [];
		for await (const row of copy.scanMemories({ after: { createdAt: rows[0].createdAt, id: rows[0].id } })) {
			resumed.push(row.id);
		}
		assert.deepEqual(
			resumed,
			rows.slice(1).map((row) => row.id),
		);
		const published = domain().runtime;
		const forwarded = [];
		domain().runtime = {
			...published,
			getMemories: (ids) => (forwarded.push(ids), published.getMemories(ids)),
		};
		let fetched;
		try {
			fetched = await copy.getMemories([id, idFor('absent')]);
		} finally {
			domain().runtime = published;
		}
		assert.deepEqual(forwarded, [[id, idFor('absent')]]);
		assert.deepEqual(
			fetched.map((row) => row.id),
			[id],
		);
		assert.ok(Array.isArray(fetched[0].embedding));
		domain().runtime = { ...published, getMemories: undefined };
		try {
			assert.deepEqual(
				(await copy.getMemories([id])).map((row) => row.id),
				[id],
			);
		} finally {
			domain().runtime = published;
		}

		unregisterSection();
		unregisterAnnotator();
		const after = await bootstrapMemories({ budget: 8000 }, alice, {});
		assert.ok(!after.memories.some((entry) => entry.section === 'late'));
	});

	it('stops a sink unregistered through the copy', async () => {
		const calls = [];
		const unregister = copy.registerMemorySink({ write: (memory) => calls.push(memory.id) });
		const kept = idFor('kept');
		await putMemory(kept, input('kept'), await pluginResolvePrincipal(member('alice')), {});
		unregister();
		await putMemory(idFor('dropped'), input('dropped'), await pluginResolvePrincipal(member('alice')), {});
		assert.deepEqual(calls, [kept]);
	});

	it('refuses to serve as a second plugin beside the running one, and the first keeps serving', async () => {
		const second = fakeScope({ urlPath: 'second' });
		await assert.rejects(copy.handleApplication(second.scope), /already serves these apps/);
		assert.equal(second.entries.size, 0);
		const viaCopy = await copy.resolvePrincipal(member('erin'));
		assert.equal(pluginCanReadLabels(viaCopy, ['global']), true);
		await putMemory(idFor('after-dup'), input('still served'), viaCopy, {});
	});

	it('publishes nothing from a deploy-validation load or a load whose options are invalid', async () => {
		const compiledBy = async (name) =>
			(await import(pathToFileURL(join(copyDir(name), 'dist', 'scopes.js')).href)).canReadLabels;
		await candidate.handleApplication(fakeScope({}, { isTransientValidation: true }).scope);
		await assert.rejects(invalid.handleApplication(fakeScope({ supersession: { mode: 'auto' } }).scope), /judge/);
		// Each resolves with its own code: had either published, the other would have delegated to it.
		assert.equal((await compiledBy('invalid'))(await invalid.resolvePrincipal(member('alice')), ['global']), true);
		assert.equal((await compiledBy('candidate'))(await candidate.resolvePrincipal(member('alice')), ['global']), true);
	});

	it("keeps another domain's registrations and the plugin's state apart", async () => {
		const calls = [];
		for (const other of [candidate, branch]) {
			other.registerMemorySink({ write: (memory) => calls.push(memory.id) });
			other.setPrincipalResolver(() => ({ id: 'intruder', superUser: true }));
			other.registerBootstrapSection({ name: 'intruder', render: () => [{ content: 'intruder' }] });
			other.registerSearchAnnotator({
				name: 'intruder',
				annotate: ({ hits }) => new Map(hits.map((hit) => [hit.id, 1])),
			});
		}
		const erin = await pluginResolvePrincipal(member('erin'));
		assert.equal(erin.id, 'agent-erin');
		await putMemory(idFor('apart'), input('apart'), erin, {});
		assert.deepEqual(calls, []);
		const booted = await bootstrapMemories({ budget: 8000 }, erin, {});
		assert.ok(!booted.memories.some((entry) => entry.section === 'intruder'));
		const searched = await (await MemoryResource.get(new URLSearchParams('q=apart'), member('erin'))).json();
		assert.ok(searched.memories.length > 0 && searched.memories.every((hit) => !('intruder' in hit)));

		const viaBranch = await branch.resolvePrincipal(member('erin'));
		assert.equal(viaBranch.id, 'intruder');
		assert.throws(() => copy.canReadLabels(viaBranch, ['global']), TypeError);
	});

	it('warns once from an unscoped copy that registers beside a running plugin', () => {
		const before = warnings.length;
		unscoped.setPrincipalResolver(undefined);
		unscoped.registerMemorySink({});
		assert.equal(warnings.length, before + 1);
		assert.match(warnings.at(-1), /loaded without its app's scope/);
	});

	it('still delegates across a major version, warning once', async () => {
		const before = warnings.length;
		const first = await skewed.resolvePrincipal(member('alice'));
		await skewed.resolvePrincipal(member('alice'));
		assert.equal(warnings.length, before + 1);
		assert.match(warnings.at(-1), /imports 1\.0\.0 but the running plugin is /);
		assert.equal(pluginCanReadLabels(first, ['global']), true);
	});

	it('reports the version in package.json', async () => {
		const { PACKAGE_VERSION } = await import('../dist/version.js');
		const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(PACKAGE_VERSION, version);
	});
});
