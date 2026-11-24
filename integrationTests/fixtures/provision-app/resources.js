// Stands in for deploy/engineering/resources.js: a deterministic embedding backend instead of the GPU host's vLLM,
// and the same Provision export.
function embedText(text, dimensions = 32) {
	const vector = new Array(dimensions).fill(0);
	vector[0] = 0.01;
	for (const token of String(text)
		.toLowerCase()
		.match(/[a-z0-9]+/g) ?? []) {
		let hash = 0;
		for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
		vector[1 + (hash % (dimensions - 1))] += 1;
	}
	return Float32Array.from(vector);
}

models.registerBackend(
	'embedding',
	'default',
	models.defineBackend({
		name: 'test-bag-of-words',
		async embed(input) {
			const texts = Array.isArray(input) ? input : [input];
			return { status: 'completed', output: texts.map((text) => embedText(text)) };
		},
	}),
);

export { Provision } from './provision.js';
