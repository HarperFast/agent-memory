// Deterministic embedding model: a hashed bag of words, registered as the plugin's default `embeddingModel`.
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

// Writes a row beneath the plugin, since every lifecycle write fails at this lockScope.
export class SeedMemory extends Resource {
	static loadAsInstance = false;
	async post(target, row) {
		await databases.memory.Memory.put(row);
		return { id: row.id };
	}
}
