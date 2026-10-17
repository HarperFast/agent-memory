import { badRequest, isCallerSafe, normalizeError, notFound } from './errors.ts';
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

const EVENT_KINDS = ['created', 'revised', 'superseded', 'withdrawn', 'restored', 'flagged'] as const;
export type MemoryEventKind = (typeof EVENT_KINDS)[number];

export interface MemoryEvent {
	id: string;
	kind: MemoryEventKind;
	revision: number;
}

class SubscriptionQueue implements AsyncIterable<MemoryEvent> {
	#buffer: MemoryEvent[] = [];
	#waiters: Array<(result: IteratorResult<MemoryEvent>) => void> = [];
	#closed = false;
	#onClose?: () => void;

	constructor(onClose?: () => void) {
		this.#onClose = onClose;
	}

	get closed(): boolean {
		return this.#closed;
	}

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
		const onClose = this.#onClose;
		this.#onClose = undefined;
		onClose?.();
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

function memoryWatchIdFor(principalId: string, memoryId: string): string {
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

async function putWatchKeepingLongerTtl(
	MemoryWatch: any,
	principalId: string,
	memoryId: string,
	expiresAt: Date,
	txn: object,
): Promise<Date> {
	const id = memoryWatchIdFor(principalId, memoryId);
	const existing = await MemoryWatch.get(id, txn);
	if (existing?.expiresAt) {
		const existingExpiresAt = new Date(existing.expiresAt);
		if (existingExpiresAt.getTime() >= expiresAt.getTime()) {
			return existingExpiresAt;
		}
	}
	await MemoryWatch.put(
		{
			id,
			principalId,
			memoryId,
			expiresAt,
		},
		txn,
	);
	return expiresAt;
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
	let effective = expiresAt;
	await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of uniqueIds) {
			const kept = await putWatchKeepingLongerTtl(MemoryWatch, principal.id, memoryId, expiresAt, txn);
			if (kept.getTime() > effective.getTime()) effective = kept;
		}
	});
	return effective.toISOString();
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
		let effective = expiresAt;
		for (const memoryId of uniqueIds) {
			const kept = await putWatchKeepingLongerTtl(MemoryWatch, principal.id, memoryId, expiresAt, txn);
			if (kept.getTime() > effective.getTime()) effective = kept;
		}
		return { watched: uniqueIds, expiresAt: effective.toISOString() };
	});
}

async function resolveDeliverableEvent(
	raw: any,
	context: Record<string, unknown>,
): Promise<{ event: MemoryEvent; record: any; currentPrincipal: Principal } | undefined> {
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
	let currentPrincipal: Principal;
	try {
		currentPrincipal = await resolvePrincipal(authContext);
	} catch (error) {
		if (isCallerSafe(error) && error.statusCode === 401) return undefined;
		throw error;
	}

	const record =
		eventRecord && typeof eventRecord.ownerId === 'string' && Array.isArray(eventRecord.scopes)
			? eventRecord
			: await memoryTable().get(id, {});
	if (!record) return undefined;

	// Matching Provenance (`forReader`), a `withdrawn` event is evaluated against the memory's scope labels
	// ignoring `status: 'withdrawn'`, so watchers and label readers learn a shared memory was withdrawn.
	const readable =
		kind === 'withdrawn'
			? canRead({ ownerId: record.ownerId, scopes: record.scopes }, currentPrincipal)
			: canRead(record, currentPrincipal);
	if (!readable) return undefined;

	if (kind === 'flagged') {
		const [view] = await forReader([toMemoryView(record)], currentPrincipal);
		if (!view?.needsReview) return undefined;
	}
	return { event: makeMemoryEvent(id, kind, revision), record, currentPrincipal };
}

interface HubListener {
	targetId?: string;
	handle: (raw: any) => Promise<void>;
	close: () => void;
}

const tableListeners = new Set<HubListener>();
const itemListeners = new Map<string, Set<HubListener>>();
let hubSub: (AsyncIterable<any> & { end?: () => void }) | undefined;
let hubOpening: Promise<void> | undefined;

function removeHubListener(listener: HubListener): void {
	if (listener.targetId !== undefined) {
		const bucket = itemListeners.get(listener.targetId);
		if (bucket) {
			bucket.delete(listener);
			if (bucket.size === 0) itemListeners.delete(listener.targetId);
		}
	} else {
		tableListeners.delete(listener);
	}
	if (tableListeners.size === 0 && itemListeners.size === 0 && hubSub) {
		const active = hubSub;
		hubSub = undefined;
		try {
			active.end?.();
		} catch {}
	}
}

async function ensureHubSubscription(): Promise<void> {
	if (hubSub) return;
	if (hubOpening) return hubOpening;
	hubOpening = (async () => {
		const rawSub = await memoryTable().subscribe({ omitCurrent: true, includeSuperseded: true }, {});
		if (tableListeners.size === 0 && itemListeners.size === 0) {
			try {
				rawSub.end?.();
			} catch {}
			return;
		}
		hubSub = rawSub;
		void (async () => {
			try {
				for await (const raw of rawSub) {
					if (hubSub !== rawSub) break;
					const id = String(raw?.id ?? raw?.value?.id ?? '');
					const byId = id ? itemListeners.get(id) : undefined;
					const snapshot = [...tableListeners, ...(byId ? [...byId] : [])];
					for (const listener of snapshot) {
						await listener.handle(raw);
					}
				}
			} catch (error) {
				if (hubSub === rawSub) {
					normalizeError(error, 'subscribe');
				}
			} finally {
				if (hubSub === rawSub) {
					hubSub = undefined;
					const remaining = [...tableListeners, ...[...itemListeners.values()].flatMap((set) => [...set])];
					tableListeners.clear();
					itemListeners.clear();
					for (const listener of remaining) listener.close();
				}
			}
		})();
	})().finally(() => {
		hubOpening = undefined;
	});
	return hubOpening;
}

async function attachToHub(
	filter: (raw: any) => Promise<MemoryEvent | undefined>,
	targetId?: string,
): Promise<SubscriptionQueue> {
	const lastRevisionById = new Map<string, number>();
	let listener: HubListener;
	const queue = new SubscriptionQueue(() => {
		removeHubListener(listener);
	});
	listener = {
		targetId,
		close: () => queue.close(),
		handle: async (raw) => {
			if (queue.closed) return;
			try {
				const event = await filter(raw);
				if (!event || queue.closed) return;
				const previous = lastRevisionById.get(event.id);
				if (previous !== undefined && event.revision <= previous) return;
				lastRevisionById.set(event.id, event.revision);
				queue.push(event);
			} catch (error) {
				normalizeError(error, 'subscribe');
			}
		},
	};
	if (targetId !== undefined) {
		let bucket = itemListeners.get(targetId);
		if (!bucket) {
			bucket = new Set();
			itemListeners.set(targetId, bucket);
		}
		bucket.add(listener);
	} else {
		tableListeners.add(listener);
	}
	try {
		await ensureHubSubscription();
	} catch (error) {
		removeHubListener(listener);
		throw error;
	}
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
		return attachToHub(async (raw) => (await resolveDeliverableEvent(raw, ctx))?.event, id);
	}

	if (target?.rest || target?.pathname) throw notFound();
	return attachToHub(async (raw) => (await resolveDeliverableEvent(raw, ctx))?.event);
}

export async function subscribeMemoryEvents(
	target: any,
	principal: Principal,
	context: object = {},
): Promise<SubscriptionQueue> {
	const ctx = context as Record<string, unknown>;
	const rawId = target?.id;
	const isWildcard = rawId === '#' || rawId === '+';
	if (target?.rest || target?.pathname || (rawId !== undefined && rawId !== null && rawId !== '' && !isWildcard)) {
		throw notFound();
	}
	const MemoryWatch = memoryWatchTable();

	return attachToHub(async (raw) => {
		const eventRecord = raw?.value;
		const id = String(raw?.id ?? eventRecord?.id ?? '');
		const kind = eventRecord?.lastEventKind;
		if (!id || !isEventKind(kind)) return undefined;

		// Check watch/ownership before resolving the subscriber's ScopeGrant or redacting provenance, so
		// unwatched events for other principals do not trigger ScopeGrant or Memory reads.
		const maybeOwnFlagged = kind === 'flagged' && (!eventRecord?.ownerId || eventRecord.ownerId === principal.id);
		if (!maybeOwnFlagged) {
			const watch = await MemoryWatch.get(memoryWatchIdFor(principal.id, id), {});
			if (!watch || new Date(watch.expiresAt).getTime() <= Date.now()) return undefined;
		}

		const deliverable = await resolveDeliverableEvent(raw, ctx);
		if (!deliverable) return undefined;
		const { event, record, currentPrincipal } = deliverable;
		if (event.kind === 'flagged' && record.ownerId === currentPrincipal.id) return event;
		if (currentPrincipal.id !== principal.id) {
			const watch = await MemoryWatch.get(memoryWatchIdFor(currentPrincipal.id, event.id), {});
			if (!watch || new Date(watch.expiresAt).getTime() <= Date.now()) return undefined;
		}
		return event;
	});
}
