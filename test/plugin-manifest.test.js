import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

// Claude Code replaces an installed plugin only when its computed version changes. With no `version` in either
// manifest that version is the marketplace's commit, so every commit to main reaches installs. A `version` in
// either file pins every install to it until someone changes the string (README › Releasing).
describe('Claude Code plugin manifests', () => {
	it('plugin.json carries no version', () => {
		assert.equal(read('claude-plugin/.claude-plugin/plugin.json').version, undefined);
	});

	it('the marketplace entry carries no version and serves ./claude-plugin', () => {
		const marketplace = read('.claude-plugin/marketplace.json');
		const entry = marketplace.plugins.find((plugin) => plugin.name === 'agent-memory');
		assert.equal(marketplace.name, 'agent-memory');
		assert.equal(entry.version, undefined);
		assert.equal(entry.source, './claude-plugin');
	});
});
