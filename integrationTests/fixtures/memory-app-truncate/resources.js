import { randomUUID } from 'node:crypto';

// A 6,000-character window and no truncate capability, like an OpenAI-compatible vLLM entry without
// `truncation: 'vllm'`.
const CONTEXT_WINDOW_CHARS = 6_000;
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
		name: 'test-window',
		async embed(input, opts) {
			const texts = Array.isArray(input) ? input : [input];
			await tables.EmbedCall.put({
				id: randomUUID(),
				inputType: texts[0]?.startsWith('search_query: ') ? 'query' : 'document',
				longest: Math.max(...texts.map((text) => text.length)),
				truncate: opts?.truncate === true,
			});
			if (texts.some((text) => text.includes('EMBED-DOWN'))) {
				throw Object.assign(new Error('embedding backend unavailable'), { upstreamStatus: 503 });
			}
			if (texts.some((text) => text.length > CONTEXT_WINDOW_CHARS)) {
				throw Object.assign(new Error("This model's maximum context length is exceeded"), { upstreamStatus: 400 });
			}
			return { status: 'completed', output: texts.map((text) => embedText(text)) };
		},
	}),
);

// Shaped like deploy/engineering's nomic-prefixed: declares truncate and passes it on to "default", which
// cannot, so on Harper 5.4 the refusal comes from the inner call.
const PREFIX = { document: 'search_document: ', query: 'search_query: ' };
models.registerBackend(
	'embedding',
	'prefixed',
	models.defineBackend({
		name: 'test-prefixed',
		truncate: true,
		async embed(input, opts) {
			const prefix = PREFIX[opts?.inputType] ?? '';
			const texts = (Array.isArray(input) ? input : [input]).map((text) => prefix + String(text));
			const output = await models.embed(
				texts,
				opts?.truncate === true
					? { model: 'default', signal: opts.signal, truncate: true }
					: { model: 'default', signal: opts?.signal },
			);
			return { status: 'completed', output };
		},
	}),
);
