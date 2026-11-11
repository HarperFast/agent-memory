import { canReadLabels, registerMemorySink, resolvePrincipal, setPrincipalResolver } from '@harperfast/agent-memory';

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
