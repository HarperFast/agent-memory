import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { models } from 'harper';
import { handleApplication } from '../dist/index.js';
import { embedTexts } from '../dist/lifecycle.js';
import { MemoryMcpResource, MemoryResource } from '../dist/resource.js';
import { applySettings, getSettings, parseSettings } from '../dist/settings.js';

function fakeScope(options) {
	const entries = new Map();
	const errors = [];
	const warnings = [];
	const watcher = new EventEmitter();
	watcher.getAll = () => options;
	return {
		entries,
		errors,
		warnings,
		setOptions(next) {
			options = next;
			watcher.emit('change');
		},
		scope: {
			options: watcher,
			logger: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
			resources: {
				set: (path, Resource) => entries.set(path, { Resource, path }),
				get: (path) => entries.get(path),
				delete: (path) => entries.delete(path),
			},
		},
	};
}

describe('handleApplication', () => {
	it('mounts all route resources at urlPath, toggles MemoryMcpResource with mcp, and moves them when options change', async () => {
		const harness = fakeScope({ urlPath: '/agent-memory/' });
		await handleApplication(harness.scope);
		assert.deepEqual(
			[...harness.entries.keys()],
			[
				'agent-memory/*rest',
				'agent-memory/bootstrap',
				'agent-memory/import',
				'agent-memory/watch',
				'agent-memory/:id',
				'agent-memory/:id/:action',
				'agent-memoryEvents',
			],
		);
		assert.equal(harness.entries.get('agent-memory/*rest').Resource, MemoryResource);

		harness.setOptions({ urlPath: 'mem', mcp: true });
		assert.deepEqual(
			[...harness.entries.keys()],
			['mem/*rest', 'mem/bootstrap', 'mem/import', 'mem/watch', 'mem/:id', 'mem/:id/:action', 'memEvents', 'memMcp'],
		);
		assert.equal(harness.entries.get('memMcp').Resource, MemoryMcpResource);

		harness.setOptions({ urlPath: 'mem', mcp: false });
		assert.deepEqual(
			[...harness.entries.keys()],
			['mem/*rest', 'mem/bootstrap', 'mem/import', 'mem/watch', 'mem/:id', 'mem/:id/:action', 'memEvents'],
		);
	});

	it('leaves a path alone once something else owns it', async () => {
		const harness = fakeScope({ urlPath: 'Memory' });
		await handleApplication(harness.scope);
		const HostResource = class HostResource {};
		harness.entries.set('Memory/*rest', { Resource: HostResource, path: 'Memory/*rest' });
		harness.setOptions({ urlPath: 'mem' });
		assert.equal(harness.entries.get('Memory/*rest').Resource, HostResource);
		assert.equal(harness.entries.has('Memory/bootstrap'), false);
		assert.equal(harness.entries.get('mem/*rest').Resource, MemoryResource);
	});

	it('keeps the previous configuration when a reload is invalid', async () => {
		const harness = fakeScope({ embeddingModel: 'first' });
		await handleApplication(harness.scope);
		harness.setOptions({ embeddingModel: 'second', limits: { contentChars: 0 } });
		assert.equal(getSettings().embeddingModel, 'first');
		assert.equal(harness.errors.length, 1);
	});

	it('warns when embeddingTruncate is on and this Harper cannot truncate', async () => {
		const stubDefineBackend = models.defineBackend;
		// Core 5.3's defineBackend ignores the spec's `truncate`; 5.4's carries it into capabilities().
		const defineBackendOf = (withTruncate) => (spec) => ({
			name: spec.name,
			capabilities: () => (withTruncate ? { embed: true, truncate: spec.truncate } : { embed: true }),
		});
		const warningsFor = async (options, reload) => {
			const harness = fakeScope(options);
			await handleApplication(harness.scope);
			if (reload) harness.setOptions(reload);
			return harness.warnings.map(([message]) => message);
		};
		const embedLong = async () => {
			const before = models.calls.length;
			await embedTexts(['x'.repeat(10_000)], { model: 'default', inputType: 'document' }, getSettings(), true);
			return models.calls.slice(before).map(({ input, options }) => [input[0].length, options.truncate === true]);
		};
		try {
			assert.deepEqual(await warningsFor({}), []);
			for (const defineBackend of [undefined, defineBackendOf(false)]) {
				models.defineBackend = defineBackend;
				const options = { embeddingTruncate: true, limits: { embeddingInputChars: 12_000 } };
				const warnings = await warningsFor(options, { ...options, mcp: true });
				assert.equal(getSettings().embeddingTruncate, true);
				assert.equal(warnings.length, 1);
				assert.match(warnings[0], /embeddingTruncate needs Harper 5\.4/);
				assert.match(warnings[0], /limits\.embeddingFallbackChars/);
				assert.deepEqual(await embedLong(), [[4_000, false]]);
			}
			models.defineBackend = defineBackendOf(true);
			assert.deepEqual(await warningsFor({ embeddingTruncate: true, limits: { embeddingInputChars: 12_000 } }), []);
			assert.deepEqual(await embedLong(), [[10_000, true]]);
		} finally {
			if (stubDefineBackend === undefined) delete models.defineBackend;
			else models.defineBackend = stubDefineBackend;
			applySettings(parseSettings({}));
		}
	});
});

describe('parseSettings', () => {
	it('applies defaults and validates limits and mcp flag', () => {
		const { customerContentCheck, ...defaults } = parseSettings({});
		assert.deepEqual(defaults, {
			urlPath: 'Memory',
			embeddingModel: 'default',
			embeddingTruncate: false,
			titleChars: 200,
			contentChars: 20000,
			embeddingInputChars: 6000,
			embeddingFallbackChars: 4000,
			supersession: { mode: 'suggest', similarity: 0.82 },
			mcp: false,
			lockScope: 'node',
		});
		assert.equal(customerContentCheck.mode, 'off');
		assert.equal(parseSettings({ mcp: true }).mcp, true);
		assert.throws(() => parseSettings({ mcp: 'true' }), /mcp/);
		assert.equal(parseSettings({ embeddingTruncate: true }).embeddingTruncate, true);
		for (const embeddingTruncate of ['true', 1, {}]) {
			assert.throws(() => parseSettings({ embeddingTruncate }), /embeddingTruncate must be a boolean/);
		}
		assert.equal(parseSettings({ lockScope: 'cluster' }).lockScope, 'cluster');
		assert.throws(() => parseSettings({ lockScope: 'global' }), /lockScope/);
		assert.throws(() => parseSettings({ limits: { titleChars: 1001 } }));
		assert.equal(parseSettings({ limits: { embeddingInputChars: 2 } }).embeddingInputChars, 2);
		assert.equal(parseSettings({ limits: { embeddingInputChars: 100_000 } }).embeddingInputChars, 100_000);
		for (const embeddingInputChars of [0, 1, 100_001, 1.5, '6000', -1]) {
			assert.throws(
				() => parseSettings({ limits: { embeddingInputChars } }),
				/limits\.embeddingInputChars must be an integer between 2 and 100000/,
			);
		}
		assert.equal(parseSettings({ limits: { embeddingFallbackChars: 2 } }).embeddingFallbackChars, 2);
		assert.equal(parseSettings({ limits: { embeddingFallbackChars: 100_000 } }).embeddingFallbackChars, 100_000);
		for (const embeddingFallbackChars of [0, 1, 100_001, 1.5, '4000', -1]) {
			assert.throws(
				() => parseSettings({ limits: { embeddingFallbackChars } }),
				/limits\.embeddingFallbackChars must be an integer between 2 and 100000/,
			);
		}
		assert.throws(() => parseSettings({ embeddingModel: '' }));
		assert.throws(() => parseSettings({ urlPath: '/' }));
	});

	it('validates supersession options, and refuses auto without a judge', () => {
		assert.deepEqual(
			parseSettings({ supersession: { mode: 'auto', similarity: 0.9, judge: 'local:judge' } }).supersession,
			{
				mode: 'auto',
				similarity: 0.9,
				judge: 'local:judge',
			},
		);
		assert.deepEqual(parseSettings({ supersession: { mode: 'off' } }).supersession, { mode: 'off', similarity: 0.82 });
		assert.deepEqual(parseSettings({ supersession: { judge: 'local:judge' } }).supersession, {
			mode: 'suggest',
			similarity: 0.82,
			judge: 'local:judge',
		});
		for (const supersession of [
			'auto',
			{ mode: 'auto' },
			{ mode: 'never' },
			{ similarity: 0 },
			{ similarity: 1.5 },
			{ similarity: '0.9' },
			{ judge: '' },
		]) {
			assert.throws(() => parseSettings({ supersession }), /supersession/, JSON.stringify(supersession));
		}
	});
});
