// nomic-embed-text-v1.5 expects "search_document: " / "search_query: " task prefixes. Harper's openai
// backend drops EmbedOpts.inputType (harper components/openai), so until core applies prefixes itself
// this app registers a thin backend that adds them and delegates to the host's local vLLM ("default").
// The prefix strings must match what core will apply later, so stored vectors stay valid after the switch.
const PREFIX = { document: 'search_document: ', query: 'search_query: ' };

models.registerBackend(
	'embedding',
	'nomic-prefixed',
	models.defineBackend({
		name: 'nomic-prefixed',
		async embed(input, opts) {
			const prefix = PREFIX[opts?.inputType] ?? '';
			const texts = (Array.isArray(input) ? input : [input]).map((text) => prefix + String(text));
			const output = await models.embed(texts, { model: 'default', signal: opts?.signal });
			return { status: 'completed', output };
		},
	}),
);
