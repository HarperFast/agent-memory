import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleApplication } from '../dist/index.js';
import { MemoryResource } from '../dist/resource.js';
import { getSettings, parseSettings } from '../dist/settings.js';

function fakeScope(options) {
	const entries = new Map();
	const errors = [];
	const watcher = new EventEmitter();
	watcher.getAll = () => options;
	return {
		entries,
		errors,
		setOptions(next) {
			options = next;
			watcher.emit('change');
		},
		scope: {
			options: watcher,
			logger: { error: (...args) => errors.push(args) },
			resources: {
				set: (path, Resource) => entries.set(path, { Resource, path }),
				get: (path) => entries.get(path),
				delete: (path) => entries.delete(path),
			},
		},
	};
}

describe('handleApplication', () => {
	it('mounts all route resources at urlPath and moves them when the option changes', async () => {
		const harness = fakeScope({ urlPath: '/agent-memory/' });
		await handleApplication(harness.scope);
		assert.deepEqual(
			[...harness.entries.keys()],
			[
				'agent-memory/*rest',
				'agent-memory/bootstrap',
				'agent-memory/import',
				'agent-memory/:id',
				'agent-memory/:id/:action',
			],
		);
		assert.equal(harness.entries.get('agent-memory/*rest').Resource, MemoryResource);

		harness.setOptions({ urlPath: 'mem' });
		assert.deepEqual(
			[...harness.entries.keys()],
			['mem/*rest', 'mem/bootstrap', 'mem/import', 'mem/:id', 'mem/:id/:action'],
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
});

describe('parseSettings', () => {
	it('applies defaults and validates limits', () => {
		assert.deepEqual(parseSettings({}), {
			urlPath: 'Memory',
			embeddingModel: 'default',
			titleChars: 200,
			contentChars: 20000,
			supersession: { mode: 'suggest', similarity: 0.82 },
		});
		assert.throws(() => parseSettings({ limits: { titleChars: 1001 } }));
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
