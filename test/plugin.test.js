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
	it('mounts the resource at urlPath and moves it when the option changes', async () => {
		const harness = fakeScope({ urlPath: '/agent-memory/' });
		await handleApplication(harness.scope);
		assert.deepEqual([...harness.entries.keys()], ['agent-memory']);
		assert.equal(harness.entries.get('agent-memory').Resource, MemoryResource);

		harness.setOptions({ urlPath: 'mem' });
		assert.deepEqual([...harness.entries.keys()], ['mem']);
	});

	it('leaves a path alone once something else owns it', async () => {
		const harness = fakeScope({ urlPath: 'Memory' });
		await handleApplication(harness.scope);
		harness.entries.set('Memory', { Resource: class HostResource {}, path: 'Memory' });
		harness.setOptions({ urlPath: 'mem' });
		assert.deepEqual([...harness.entries.keys()].sort(), ['Memory', 'mem']);
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
		});
		assert.throws(() => parseSettings({ limits: { titleChars: 1001 } }));
		assert.throws(() => parseSettings({ embeddingModel: '' }));
		assert.throws(() => parseSettings({ urlPath: '/' }));
	});
});
