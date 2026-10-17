import { EventEmitter } from 'node:events';
import { badRequest, notFound } from './errors.ts';
import {
	inOwnTransaction,
	isMemoryId,
	memoryTable,
	memoryWatchTable,
	rejectUnknownFields,
	toMemoryView,
} from './lifecycle.ts';
import { resolvePrincipal } from './principal.ts';
import { forReader } from './provenance.ts';
import { canRead, type Principal } from './scopes.ts';

export const EVENT_KINDS = ['created', 'revised', 'superseded', 'withdrawn', 'restored', 'flagged'] as const;
export type MemoryEventKind = (typeof EVENT_KINDS)[number];

export interface MemoryEvent {
	id: string;
	kind: MemoryEventKind;
	revision: number;
}

export class SubscriptionQueue extends EventEmitter implements AsyncIterable<MemoryEvent> {
	#buffer: MemoryEvent[] = [];
	#waiters: Array<(result: IteratorResult<MemoryEvent>) => void> = [];
	#closed = false;

	push(event: MemoryEvent): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.#buffer.push(event);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		while (this.#waiters.length > 0) {
			const waiter = this.#waiters.shift()!;
			waiter({ value: undefined as any, done: true });
		}
		this.emit('close');
	}

	end(): void {
		this.close();
	}

	[Symbol.asyncIterator](): AsyncIterator<MemoryEvent> {
		return {
			next: () => {
				if (this.#buffer.length > 0) {
					return Promise.resolve({ value: this.#buffer.shift()!, done: false });
				}
				if (this.#closed) {
					return Promise.resolve({ value: undefined as any, done: true });
				}
				return new Promise<IteratorResult<MemoryEvent>>((resolve) => {
					this.#waiters.push(resolve);
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({ value: undefined as any, done: true });
			},
			throw: (error) => {
				this.close();
				return Promise.reject(error);
			},
		};
	}
}

export const WATCH_DEFAULT_TTL_SECONDS = 3600;
export const WATCH_MAX_TTL_SECONDS = 86_400;
export const WATCH_MAX_IDS = 100;
const WATCH_FIELDS = ['ids', 'ttlSeconds'];

export function memoryWatchIdFor(principalId: string, memoryId: string): string {
	return `${principalId}:${memoryId}`;
}

function isEventKind(value: unknown): value is MemoryEventKind {
	return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

function makeMemoryEvent(id: string, kind: MemoryEventKind, revision: number): MemoryEvent {
	const event: MemoryEvent = { id, kind, revision };
	// Harper's MQTT broker reads `update.id` and serializes `update.value`, whereas SSE and WebSocket
	// serialize the yielded object itself; a non-enumerable self-reference serves both with `{ id, kind, revision }`.
	Object.defineProperty(event, 'value', { value: event, enumerable: false });
	return event;
}

export async function recordWatches(
	ids: readonly string[],
	principal: Principal,
	ttlSeconds: number,
	requestContext: object = {},
): Promise<string> {
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return expiresAt.toISOString();
	const MemoryWatch = memoryWatchTable();
	await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of uniqueIds) {
			await MemoryWatch.put(
				{
					id: memoryWatchIdFor(principal.id, memoryId),
					principalId: principal.id,
					memoryId,
					expiresAt,
				},
				txn,
			);
		}
	});
	return expiresAt.toISOString();
}

export async function watchMemories(input: unknown, principal: Principal, requestContext: object = {}) {
	const payload = rejectUnknownFields(input, WATCH_FIELDS, 'watch');
	if (!Array.isArray(payload.ids) || payload.ids.length === 0 || !payload.ids.every(isMemoryId)) {
		throw badRequest('ids must be a non-empty array of memory ids', 'invalid_ids');
	}
	if (payload.ids.length > WATCH_MAX_IDS) {
		throw badRequest(`ids exceeds ${WATCH_MAX_IDS} items`, 'ids_too_many');
	}
	if (
		payload.ttlSeconds !== undefined &&
		payload.ttlSeconds !== null &&
		(!Number.isInteger(payload.ttlSeconds) ||
			(payload.ttlSeconds as number) < 1 ||
			(payload.ttlSeconds as number) > WATCH_MAX_TTL_SECONDS)
	) {
		throw badRequest(`ttlSeconds must be an integer between 1 and ${WATCH_MAX_TTL_SECONDS}`, 'invalid_ttlSeconds');
	}
	const ttlSeconds = (payload.ttlSeconds ?? WATCH_DEFAULT_TTL_SECONDS) as number;
	const uniqueIds = [...new Set(payload.ids as string[])];
	const Memory = memoryTable();
	const MemoryWatch = memoryWatchTable();

	return inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of uniqueIds) {
			const record = await Memory.get(memoryId, txn);
			// Same 404 whether missing or unreadable, so watch cannot probe another principal's memory.
			if (!record || !canRead(record, principal)) throw notFound();
		}
		const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
		for (const memoryId of uniqueIds) {
			await MemoryWatch.put(
				{
					id: memoryWatchIdFor(principal.id, memoryId),
					principalId: principal.id,
					memoryId,
					expiresAt,
				},
				txn,
			);
		}
		return { watched: uniqueIds, expiresAt: expiresAt.toISOString() };
	});
}

async function resolveDeliverableEvent(
	raw: any,
	context: Record<string, unknown>,
): Promise<{ event: MemoryEvent; currentRecord: any; currentPrincipal: Principal } | undefined> {
	const eventRecord = raw?.value;
	const id = String(raw?.id ?? eventRecord?.id ?? '');
	const kind = eventRecord?.lastEventKind;
	const revision = eventRecord?.revision;
	if (!id || !isEventKind(kind) || typeof revision !== 'number') return undefined;

	// Re-resolve at delivery time so a scope grant or principal change revokes visibility mid-subscription.
	const authContext = Object.assign(Object.create(context), {
		user: context.user,
		headers: context.headers,
		transaction: undefined,
		authorize: false,
	});
	const currentPrincipal = await resolvePrincipal(authContext).catch(() => undefined);
	if (!currentPrincipal) return undefined;

	const Memory = memoryTable();
	const currentRecord = (await Memory.get(id, {})) ?? eventRecord;
	if (!canRead(eventRecord, currentPrincipal) || !canRead(currentRecord, currentPrincipal)) return undefined;

	if (kind === 'flagged') {
		const [view] = await forReader([toMemoryView(eventRecord)], currentPrincipal);
		if (!view?.needsReview) return undefined;
	}
	return { event: makeMemoryEvent(id, kind, revision), currentRecord, currentPrincipal };
}

function pipeSubscription(
	rawSub: AsyncIterable<any> & { end?: () => void },
	filter: (raw: any) => Promise<MemoryEvent | undefined>,
): SubscriptionQueue {
	const queue = new SubscriptionQueue();
	let closed = false;
	const stop = () => {
		if (closed) return;
		closed = true;
		try {
			rawSub.end?.();
		} catch {
			// Ignore close errors on already-ended subscriptions.
		}
	};
	queue.on('close', stop);

	void (async () => {
		try {
			for await (const raw of rawSub) {
				if (closed) break;
				const event = await filter(raw);
				if (event && !closed) queue.push(event);
			}
		} catch {
			// Underlying subscription closed.
		} finally {
			stop();
		}
	})();

	return queue;
}

export async function subscribeMemory(
	target: any,
	principal: Principal,
	context: object = {},
): Promise<SubscriptionQueue> {
	const ctx = context as Record<string, unknown>;
	const Memory = memoryTable();

	const rawId = target?.id;
	const isWildcard = rawId === '#' || rawId === '+';
	const hasTargetId = rawId !== undefined && rawId !== null && rawId !== '' && !isWildcard;

	if (hasTargetId) {
		const id = String(rawId);
		const existing = isMemoryId(id) ? await Memory.get(id, ctx) : undefined;
		if (!existing || !canRead(existing, principal)) throw notFound();
		const rawSub = await Memory.subscribe({ id, omitCurrent: true, includeSuperseded: true }, {});
		return pipeSubscription(rawSub, async (raw) => (await resolveDeliverableEvent(raw, ctx))?.event);
	}

	if (target?.rest || target?.pathname) throw notFound();
	const rawSub = await Memory.subscribe({ omitCurrent: true, includeSuperseded: true }, {});
	return pipeSubscription(rawSub, async (raw) => (await resolveDeliverableEvent(raw, ctx))?.event);
}

export async function subscribeMemoryEvents(
	target: any,
	_principal: Principal,
	context: object = {},
): Promise<SubscriptionQueue> {
	const ctx = context as Record<string, unknown>;
	const rawId = target?.id;
	const isWildcard = rawId === '#' || rawId === '+';
	if (target?.rest || target?.pathname || (rawId !== undefined && rawId !== null && rawId !== '' && !isWildcard)) {
		throw notFound();
	}
	const Memory = memoryTable();
	const MemoryWatch = memoryWatchTable();
	const rawSub = await Memory.subscribe({ omitCurrent: true, includeSuperseded: true }, {});

	return pipeSubscription(rawSub, async (raw) => {
		const deliverable = await resolveDeliverableEvent(raw, ctx);
		if (!deliverable) return undefined;
		const { event, currentRecord, currentPrincipal } = deliverable;
		const ownFlagged = event.kind === 'flagged' && currentRecord.ownerId === currentPrincipal.id;
		if (ownFlagged) return event;
		const watch = await MemoryWatch.get(memoryWatchIdFor(currentPrincipal.id, event.id), {});
		if (watch && new Date(watch.expiresAt).getTime() > Date.now()) return event;
		return undefined;
	});
}
