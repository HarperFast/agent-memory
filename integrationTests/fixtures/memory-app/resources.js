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
			// Holds a write open between its revision check and its commit, so concurrent writers overlap.
			if ([input].flat().some((text) => String(text).includes('slowly')))
				await new Promise((resolve) => setTimeout(resolve, 50));
			return { status: 'completed', output: (Array.isArray(input) ? input : [input]).map((text) => embedText(text)) };
		},
	}),
);

// Registered from the host app's own import of the package, as harper-eye will. The sink writes its row before it
// can throw, so a failure has to roll that row back too.
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

// erin authenticates as a Harper user but acts as an app-defined principal with its own grants.
setPrincipalResolver((context, next) =>
	context.user?.username === 'erin'
		? { id: 'agent-erin', grants: { read: ['global'], write: ['global'] }, source: 'fixture-resolver' }
		: next(),
);
