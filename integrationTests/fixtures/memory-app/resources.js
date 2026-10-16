import { registerMemorySink, setPrincipalResolver } from '@harperfast/agent-memory';

// Deterministic embedding model for the integration suite: a hashed bag of words, so two texts are close
// exactly when they share words. Registered as the plugin's default `embeddingModel`.
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
			if (texts.some((text) => String(text).includes('EMBED-FAIL'))) {
				throw Object.assign(new Error('embedding backend rate limited'), { upstreamStatus: 429 });
			}
			// Holds a write open between its revision check and its commit, so concurrent writers overlap.
			if (texts.some((text) => String(text).includes('slowly')))
				await new Promise((resolve) => setTimeout(resolve, 50));
			return { status: 'completed', output: texts.map((text) => embedText(text)) };
		},
	}),
);

// Deterministic supersession judge: decides by a marker in the new memory, which the prompt puts first.
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

// Writes before it can throw, so a failure must roll this row back along with the memory.
const record = (kind) => async (memory, context) => {
	await databases.memory.SinkLog.put(
		{
			id: `${memory.id}:${memory.revision}`,
			kind,
			memoryId: memory.id,
			status: memory.status,
			revision: memory.revision,
		},
		context,
	);
	if (String(memory.content).includes('SINK-FAIL')) throw new Error('sink rejected the memory');
};
registerMemorySink({ write: record('write'), withdraw: record('withdraw') });

setPrincipalResolver((context, next) =>
	context.user?.username === 'erin'
		? { id: 'agent-erin', grants: { read: ['global'], write: ['global'] }, source: 'fixture-resolver' }
		: next(),
);

// Runs a vector query whose size differs from the index's, as a model switch would; search's fallback to
// full-text depends on Harper answering it with a 400 starting with "Search target has ".
export class MismatchProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		try {
			for await (const _ of databases.memory.Memory.search({
				sort: { attribute: 'embedding', target: new Array(64).fill(0.1) },
				select: ['id'],
				limit: 1,
			}));
			return { statusCode: 200, startsWithSearchTarget: false };
		} catch (error) {
			return {
				statusCode: error?.statusCode,
				startsWithSearchTarget: String(error?.message).startsWith('Search target has '),
			};
		}
	}
}
