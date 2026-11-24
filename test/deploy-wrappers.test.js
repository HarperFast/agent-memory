import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// deploy/<env>/resources.js runs as a Harper jsResource, where `models` is a global.
const previousModels = globalThis.models;

async function load(env) {
	const registered = new Map();
	const inner = [];
	globalThis.models = {
		// Shaped like core 5.4's: the spec's `truncate` becomes the backend's capability.
		defineBackend: (spec) => ({ ...spec, capabilities: () => ({ embed: true, truncate: spec.truncate === true }) }),
		registerBackend: (kind, name, backend) => registered.set(`${kind}:${name}`, backend),
		async embed(texts, options) {
			inner.push({ texts, options });
			return texts.map(() => Float32Array.of(1));
		},
	};
	const module = await import(`../deploy/${env}/resources.js`);
	return { backend: registered.get('embedding:nomic-prefixed'), inner, module };
}

after(() => {
	globalThis.models = previousModels;
});

for (const env of ['engineering', 'harper-eye']) {
	describe(`${env} nomic-prefixed backend`, () => {
		let backend;
		let inner;
		before(async () => {
			({ backend, inner } = await load(env));
		});

		it('declares the truncate capability', () => {
			assert.equal(backend.capabilities().truncate, true);
		});

		it('prefixes by input type and passes truncate on to the default entry only when asked', async () => {
			const signal = new AbortController().signal;
			await backend.embed(['a', 'b'], { inputType: 'document', truncate: true, signal });
			await backend.embed('q', { inputType: 'query', signal });
			await backend.embed('plain', {});
			assert.deepEqual(inner, [
				{ texts: ['search_document: a', 'search_document: b'], options: { model: 'default', signal, truncate: true } },
				{ texts: ['search_query: q'], options: { model: 'default', signal } },
				{ texts: ['plain'], options: { model: 'default', signal: undefined } },
			]);
		});
	});
}

describe('engineering self-serve provisioning wiring', () => {
	it('exports the Provision resource, hidden from MCP and OpenAPI, and declares its table schema', async () => {
		const { module } = await load('engineering');
		assert.equal(module.Provision?.hidden, true);
		const config = readFileSync(new URL('../deploy/engineering/config.yaml', import.meta.url), 'utf8');
		assert.match(config, /^graphqlSchema:\n {2}files: 'schema\.graphql'$/m);
		const schema = readFileSync(new URL('../deploy/engineering/schema.graphql', import.meta.url), 'utf8');
		assert.match(schema, /type ProvisionedUser @table\(database: "memory"\) @sealed/);
		assert.doesNotMatch(schema, /@export/);
	});

	it('defines eng-public as global-only and gives the provisioner no grants', () => {
		const operations = JSON.parse(readFileSync(new URL('../deploy/engineering/roles.json', import.meta.url), 'utf8'));
		const roles = operations.filter((op) => op.operation === 'add_role');
		assert.deepEqual(
			roles.map(({ role, permission }) => [role, permission]),
			[
				['eng-public', { super_user: false }],
				['provisioner', { super_user: false }],
			],
		);
		const grants = operations.filter((op) => op.table === 'ScopeGrant').flatMap((op) => op.records);
		assert.deepEqual(grants, [{ id: 'role:eng-public', read: ['global'], write: ['global'] }]);
	});
});
