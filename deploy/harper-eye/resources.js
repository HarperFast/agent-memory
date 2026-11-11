// nomic-embed-text-v1.5 expects "search_document: " / "search_query: " task prefixes. They are added here, in this
// app, rather than as core inputPrefixes on the models.embedding.default entry, which other apps may share.
// The strings must stay byte-identical, or stored vectors stop matching.
const PREFIX = { document: 'search_document: ', query: 'search_query: ' };

models.registerBackend(
	'embedding',
	'nomic-prefixed',
	models.defineBackend({
		name: 'nomic-prefixed',
		// Passed on to "default", which honors it only when its entry can truncate. For vLLM that is truncation: 'vllm',
		// where core sends truncation_side: 'right' (vLLM 0.18+), which keeps the start of each input, so the prefix
		// survives the cut.
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
