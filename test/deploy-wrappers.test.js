import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
	await import(`../deploy/${env}/resources.js`);
	return { backend: registered.get('embedding:nomic-prefixed'), inner };
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
