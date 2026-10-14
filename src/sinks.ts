export interface MemorySink {
	write?(memory: Record<string, unknown>, context: object): unknown;
	withdraw?(memory: Record<string, unknown>, context: object): unknown;
}

const sinks: MemorySink[] = [];

/**
 * Called inside the lifecycle transaction for every memory row a lifecycle operation changes. A write the sink
 * makes through `context` to a table in the `memory` database commits or rolls back with the memory, and a sink
 * that throws aborts the operation. Harper commits each database separately, so a write to another database
 * can be lost if the process dies between the two commits; effects outside Harper are not transactional at
 * all. Use an outbox table in the `memory` database for anything that must not be lost. Returns an unregister
 * function.
 */
export function registerMemorySink(sink: MemorySink): () => void {
	sinks.push(sink);
	return () => {
		const index = sinks.indexOf(sink);
		if (index !== -1) sinks.splice(index, 1);
	};
}

export function hasSinks(): boolean {
	return sinks.length > 0;
}

/** Dispatches to the sinks registered when it starts; an unregister during dispatch takes effect on the next one. */
export async function notifySinks(
	kind: 'write' | 'withdraw',
	memory: Record<string, unknown>,
	context: object,
): Promise<void> {
	for (const sink of sinks.slice()) await sink[kind]?.(memory, context);
}
