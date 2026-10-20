// The same deterministic models as the main fixture: a hashed bag of words for embeddings, and a judge that
// decides by a marker in the new memory, which the prompt puts first.
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

models.registerBackend(
	'generative',
	'judge-stub',
	models.defineBackend({
		name: 'test-judge',
		async generate(input) {
			const prompt = input.messages.at(-1).content;
			const written = prompt.slice(0, prompt.indexOf('<existing_memory>'));
			const content = written.includes('REPLACES')
				? 'supersedes'
				: written.includes('EXTENDS')
					? 'refines'
					: 'unrelated';
			return { status: 'completed', output: { content, finishReason: 'stop' } };
		},
	}),
);
