export interface MemorySink {
	write?(memory: Record<string, unknown>, context: object): unknown;
	withdraw?(memory: Record<string, unknown>, context: object): unknown;
}

const sinks: MemorySink[] = [];

/**
 * Called inside the lifecycle transaction for every memory row a lifecycle operation changes. A sink that
 * writes Harper tables through `context` commits or rolls back with the memory; a sink that throws aborts
 * the operation. Effects outside Harper are not transactional. Returns an unregister function.
 */
export function registerMemorySink(sink: MemorySink): () => void {
	sinks.push(sink);
	return () => {
		const index = sinks.indexOf(sink);
		if (index !== -1) sinks.splice(index, 1);
	};
}

export async function notifySinks(
	kind: 'write' | 'withdraw',
	memory: Record<string, unknown>,
	context: object,
): Promise<void> {
	for (const sink of sinks) await sink[kind]?.(memory, context);
}
