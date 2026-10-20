// Deterministic embedding model: a hashed bag of words, so two texts are close exactly when they share words.
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

// Deterministic customer-content model: answers by a marker in the memory text.
models.registerBackend(
	'generative',
	'content-stub',
	models.defineBackend({
		name: 'test-content-check',
		async generate(input) {
			const content = input.messages.at(-1).content.includes('MODEL-SAYS-CUSTOMER') ? 'customer' : 'clean';
			return { status: 'completed', output: { content, finishReason: 'stop' } };
		},
	}),
);

// Writes a Memory row shaped as the plugin wrote them before contentFlag existed. It runs on a worker, where the
// embedding backend above is registered; the operations API runs where it is not.
export class LegacyMemoryWriter extends Resource {
	static loadAsInstance = false;
	async post(_target, data) {
		const record = await data;
		await databases.memory.Memory.put(record);
		return { written: record.id };
	}
}
