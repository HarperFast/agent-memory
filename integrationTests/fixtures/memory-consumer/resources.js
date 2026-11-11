import {
	canReadLabels,
	registerBootstrapSection,
	registerMemorySink,
	registerSearchAnnotator,
	resolvePrincipal,
	scanMemories,
	setPrincipalResolver,
} from '@harperfast/agent-memory';

// Writes before it can throw, so a failure must roll this row back along with the memory.
const record = (kind) => async (memory, context) => {
	await databases.memory.SinkLog.put(
		{
			id: `${memory.id}:${memory.revision}:${kind}`,
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
		? { id: 'agent-erin', grants: { read: ['global'], write: ['global'] }, source: 'consumer-resolver' }
		: next(),
);

registerBootstrapSection({
	name: 'consumerOrientation',
	render: ({ principal, budgetChars }) => [
		{ title: 'Orientation', content: `for ${principal.id} within ${budgetChars}` },
	],
});

// The Map is made in this app's realm; under the vm loader that is not the plugin's realm.
registerSearchAnnotator({
	name: 'consumerNote',
	annotate: ({ principal, hits }) =>
		new Map(hits.map((hit) => [hit.id, { by: principal.id, readable: canReadLabels(principal, hit.scopes) }])),
});

export class ScanProbe extends Resource {
	static async get() {
		const rows = [];
		for await (const row of scanMemories()) rows.push(row);
		const resumed = [];
		for await (const row of scanMemories({ after: { createdAt: rows[0].createdAt, id: rows[0].id } })) {
			resumed.push(row.id);
		}
		return {
			ids: rows.map((row) => row.id),
			resumed,
			embedded: rows.every((row) => row.embedding?.length > 0 && row.embeddingModel === 'default'),
		};
	}
}

export class PrincipalProbe extends Resource {
	static async get(target, context) {
		const principal = await resolvePrincipal(context);
		const labels = target.get('labels')?.split(',') ?? [];
		return {
			principal,
			canRead: canReadLabels(principal, labels),
			packagePath: import.meta.resolve('@harperfast/agent-memory'),
			seesServiceGlobal: globalThis[Symbol.for('agent-memory-fixture/service-global')] === true,
		};
	}
}
