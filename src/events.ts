import { databases } from 'harper';
import { badRequest, isCallerSafe, normalizeError, notFound } from './errors.ts';
import {
	inOwnTransaction,
	isMemoryId,
	memoryTable,
	memoryWatchTable,
	rejectUnknownFields,
	toMemoryView,
} from './lifecycle.ts';
import { hasCustomPrincipalResolver, resolvePrincipal } from './principal.ts';
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

const MAX_PENDING_EVENTS_PER_LISTENER = 256;
const MAX_DEDUP_ENTRIES = 1024;
const ERROR_LOG_INTERVAL_MS = 60_000;
const PRINCIPAL_CACHE_TTL_MS = 5_000;

function memoryWatchIdFor(principalId: string, memoryId: string): string {
	return `${principalId}:${memoryId}`;
}

function isEventKind(value: unknown): value is MemoryEventKind {
	return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

// In-memory index of active watches (`principalId -> (memoryId -> expiresAtMs)`), kept in sync by
// watch writes, initial seeding when `/MemoryEvents` opens, and the hub's `MemoryWatch` subscription.
const watchesByPrincipal = new Map<string, Map<string, number>>();
const seededWatchPrincipals = new Set<string>();

function recordWatchInMemory(principalId: string, memoryId: string, expiresAtMs: number, keepLonger = true): void {
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
	let bucket = watchesByPrincipal.get(principalId);
	if (!bucket) {
		bucket = new Map();
		watchesByPrincipal.set(principalId, bucket);
	}
	const previous = bucket.get(memoryId);
	if (keepLonger && previous !== undefined && previous >= expiresAtMs) return;
	bucket.set(memoryId, expiresAtMs);
}

function removeWatchFromMemory(principalId: string, memoryId: string): void {
	const bucket = watchesByPrincipal.get(principalId);
	if (!bucket) return;
	bucket.delete(memoryId);
	if (bucket.size === 0) watchesByPrincipal.delete(principalId);
}

function applyWatchEvent(raw: any): void {
	const watch = raw?.value;
	const rawId = String(raw?.id ?? watch?.id ?? '');
	const sep = rawId.indexOf(':');
	const principalId = typeof watch?.principalId === 'string' ? watch.principalId : sep > 0 ? rawId.slice(0, sep) : '';
	const memoryId = typeof watch?.memoryId === 'string' ? watch.memoryId : sep > 0 ? rawId.slice(sep + 1) : '';
	if (!principalId || !memoryId) return;
	if (raw?.type === 'delete' || !watch?.expiresAt) {
		removeWatchFromMemory(principalId, memoryId);
		return;
	}
	const expiresAtMs = new Date(watch.expiresAt).getTime();
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
		removeWatchFromMemory(principalId, memoryId);
		return;
	}
	recordWatchInMemory(principalId, memoryId, expiresAtMs, false);
}

function hasActiveWatch(principalId: string, memoryId: string): boolean {
	const bucket = watchesByPrincipal.get(principalId);
	if (!bucket) return false;
	const expiresAtMs = bucket.get(memoryId);
	if (expiresAtMs === undefined) return false;
	if (expiresAtMs <= Date.now()) {
		bucket.delete(memoryId);
		if (bucket.size === 0) watchesByPrincipal.delete(principalId);
		return false;
	}
	return true;
}

const seedingWatchPrincipals = new Map<string, Promise<void>>();

async function ensurePrincipalWatchesSeeded(principalId: string): Promise<void> {
	if (seededWatchPrincipals.has(principalId)) return;
	const existing = seedingWatchPrincipals.get(principalId);
	if (existing) return existing;
	const promise = (async () => {
		try {
			const MemoryWatch = memoryWatchTable();
			const now = Date.now();
			for await (const row of MemoryWatch.search(
				{ conditions: [{ attribute: 'principalId', comparator: 'equals', value: principalId }] },
				{},
			)) {
				if (typeof row?.memoryId !== 'string' || !row?.expiresAt) continue;
				const expMs = new Date(row.expiresAt).getTime();
				if (expMs > now) {
					recordWatchInMemory(principalId, row.memoryId, expMs);
				}
			}
			seededWatchPrincipals.add(principalId);
		} finally {
			seedingWatchPrincipals.delete(principalId);
		}
	})();
	seedingWatchPrincipals.set(principalId, promise);
	return promise;
}

interface CachedPrincipal {
	principal: Principal;
	expiresAtMs: number;
}

const principalCache = new Map<string, CachedPrincipal>();
const inflightPrincipals = new Map<string, Promise<Principal>>();
let lastScopeGrantGet: unknown;

function scopeGrantTable(): any {
	return (databases as any).memory?.ScopeGrant;
}

function clearPrincipalCache(): void {
	principalCache.clear();
	inflightPrincipals.clear();
}

function harperUserCacheKey(context: Record<string, unknown>): string | undefined {
	if (hasCustomPrincipalResolver()) return undefined;
	const user = context.user as any;
	if (typeof user?.username !== 'string' || user.username.length === 0) return undefined;
	const roleName = typeof user.role?.role === 'string' ? user.role.role : '';
	const isSuper = user.role?.permission?.super_user === true ? '1' : '0';
	return `${user.username}\0${roleName}\0${isSuper}`;
}

async function resolveSubscriberPrincipal(authContext: Record<string, unknown>): Promise<Principal> {
	const currentGrantGet = scopeGrantTable()?.get;
	if (currentGrantGet !== lastScopeGrantGet) {
		lastScopeGrantGet = currentGrantGet;
		clearPrincipalCache();
	}
	const key = harperUserCacheKey(authContext);
	if (!key) {
		return resolvePrincipal(authContext);
	}
	const now = Date.now();
	const cached = principalCache.get(key);
	if (cached && cached.expiresAtMs > now) {
		return cached.principal;
	}
	const existing = inflightPrincipals.get(key);
	if (existing) return existing;
	const promise = resolvePrincipal(authContext).then(
		(resolved) => {
			inflightPrincipals.delete(key);
			principalCache.set(key, { principal: resolved, expiresAtMs: Date.now() + PRINCIPAL_CACHE_TTL_MS });
			return resolved;
		},
		(error) => {
			inflightPrincipals.delete(key);
			throw error;
		},
	);
	inflightPrincipals.set(key, promise);
	return promise;
}

async function putWatchKeepingLongerTtl(
	MemoryWatch: any,
	principalId: string,
	memoryId: string,
	expiresAt: Date,
	txn: object,
): Promise<Date> {
	const id = memoryWatchIdFor(principalId, memoryId);
	await MemoryWatch.lock?.(id, {}, txn);
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
	let earliest: Date | undefined;
	const written: Array<[string, number]> = [];
	await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of uniqueIds) {
			const kept = await putWatchKeepingLongerTtl(MemoryWatch, principal.id, memoryId, expiresAt, txn);
			if (!earliest || kept.getTime() < earliest.getTime()) earliest = kept;
			written.push([memoryId, kept.getTime()]);
		}
	});
	for (const [memoryId, expMs] of written) {
		recordWatchInMemory(principal.id, memoryId, expMs);
	}
	return (earliest ?? expiresAt).toISOString();
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
	const written: Array<[string, number]> = [];

	const result = await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of uniqueIds) {
			const record = await Memory.get(memoryId, txn);
			// Same 404 whether missing or unreadable, so watch cannot probe another principal's memory.
			if (!record || !canRead(record, principal)) throw notFound();
		}
		const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
		let earliest: Date | undefined;
		for (const memoryId of uniqueIds) {
			const kept = await putWatchKeepingLongerTtl(MemoryWatch, principal.id, memoryId, expiresAt, txn);
			if (!earliest || kept.getTime() < earliest.getTime()) earliest = kept;
			written.push([memoryId, kept.getTime()]);
		}
		return { watched: uniqueIds, expiresAt: (earliest ?? expiresAt).toISOString() };
	});
	for (const [memoryId, expMs] of written) {
		recordWatchInMemory(principal.id, memoryId, expMs);
	}
	return result;
}

interface DeliverableEvent {
	event: MemoryEvent;
	record: any;
	currentPrincipal: Principal;
	dedupToken: string;
}

async function resolveDeliverableEvent(
	raw: any,
	context: Record<string, unknown>,
): Promise<DeliverableEvent | undefined> {
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
		currentPrincipal = await resolveSubscriberPrincipal(authContext);
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
	const updatedStamp =
		record.updatedAt instanceof Date ? String(record.updatedAt.getTime()) : String(record.updatedAt ?? '');
	const dedupToken = `${revision}:${kind}:${updatedStamp}`;
	return { event: { id, kind, revision }, record, currentPrincipal, dedupToken };
}

interface HubListener {
	targetId?: string;
	enqueue: (raw: any) => void;
	close: () => void;
}

type UpstreamSub = AsyncIterable<any> & { end?: () => void };

const tableListeners = new Set<HubListener>();
const itemListeners = new Map<string, Set<HubListener>>();
let hubSub: UpstreamSub | undefined;
let watchHubSub: UpstreamSub | undefined;
let grantHubSub: UpstreamSub | undefined;
let hubOpening: Promise<void> | undefined;

function closeUpstreamSub(sub: UpstreamSub | undefined): void {
	if (!sub) return;
	try {
		sub.end?.();
	} catch {}
}

function resetHubState(): void {
	const activeMem = hubSub;
	const activeWatch = watchHubSub;
	const activeGrant = grantHubSub;
	hubSub = undefined;
	watchHubSub = undefined;
	grantHubSub = undefined;
	watchesByPrincipal.clear();
	seededWatchPrincipals.clear();
	seedingWatchPrincipals.clear();
	clearPrincipalCache();
	closeUpstreamSub(activeMem);
	closeUpstreamSub(activeWatch);
	closeUpstreamSub(activeGrant);
}

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
		resetHubState();
	}
}

async function ensureHubSubscription(): Promise<void> {
	if (hubSub) return;
	if (hubOpening) return hubOpening;
	let opening: Promise<void> | undefined;
	opening = (async () => {
		try {
			const Memory = memoryTable();
			const MemoryWatch = memoryWatchTable();
			const ScopeGrant = scopeGrantTable();
			const rawSub = await Memory.subscribe({ omitCurrent: true, includeSuperseded: true }, {});
			const rawWatchSub =
				typeof MemoryWatch?.subscribe === 'function'
					? await MemoryWatch.subscribe({ omitCurrent: true }, {})
					: undefined;
			const rawGrantSub =
				typeof ScopeGrant?.subscribe === 'function' ? await ScopeGrant.subscribe({ omitCurrent: true }, {}) : undefined;
			if (tableListeners.size === 0 && itemListeners.size === 0) {
				closeUpstreamSub(rawSub);
				closeUpstreamSub(rawWatchSub);
				closeUpstreamSub(rawGrantSub);
				return;
			}
			hubSub = rawSub;
			watchHubSub = rawWatchSub;
			grantHubSub = rawGrantSub;

			if (rawWatchSub) {
				void (async () => {
					try {
						for await (const raw of rawWatchSub) {
							if (watchHubSub !== rawWatchSub) break;
							applyWatchEvent(raw);
						}
					} catch {}
				})();
			}

			if (rawGrantSub) {
				void (async () => {
					try {
						for await (const _ of rawGrantSub) {
							if (grantHubSub !== rawGrantSub) break;
							clearPrincipalCache();
						}
					} catch {}
				})();
			}

			void (async () => {
				try {
					for await (const raw of rawSub) {
						if (hubSub !== rawSub) break;
						const id = String(raw?.id ?? raw?.value?.id ?? '');
						const byId = id ? itemListeners.get(id) : undefined;
						const snapshot = [...tableListeners, ...(byId ? [...byId] : [])];
						for (const listener of snapshot) {
							listener.enqueue(raw);
						}
					}
				} catch (error) {
					if (hubSub === rawSub) {
						normalizeError(error, 'subscribe');
					}
				} finally {
					if (hubSub === rawSub) {
						resetHubState();
						const remaining = [...tableListeners, ...[...itemListeners.values()].flatMap((set) => [...set])];
						tableListeners.clear();
						itemListeners.clear();
						for (const listener of remaining) listener.close();
					}
				}
			})();
		} finally {
			if (hubOpening === opening) {
				hubOpening = undefined;
			}
		}
	})();
	hubOpening = opening;
	return opening;
}

interface FilteredDelivery {
	event: MemoryEvent;
	dedupToken: string;
}

async function attachToHub(
	filter: (raw: any) => Promise<FilteredDelivery | undefined>,
	targetId?: string,
): Promise<SubscriptionQueue> {
	const lastSeenById = new Map<string, { revision: number; token: string }>();
	let pendingCount = 0;
	let chain: Promise<void> = Promise.resolve();
	let lastErrorLogAt = 0;
	let listener: HubListener;
	const queue = new SubscriptionQueue(() => {
		removeHubListener(listener);
	});
	listener = {
		targetId,
		close: () => queue.close(),
		enqueue: (raw) => {
			if (queue.closed || pendingCount >= MAX_PENDING_EVENTS_PER_LISTENER) return;
			pendingCount += 1;
			chain = chain.then(async () => {
				try {
					if (queue.closed) return;
					const delivered = await filter(raw);
					if (!delivered || queue.closed) return;
					const { event, dedupToken } = delivered;
					const previous = lastSeenById.get(event.id);
					if (previous !== undefined) {
						if (event.revision < previous.revision || previous.token === dedupToken) return;
						lastSeenById.delete(event.id);
					} else if (lastSeenById.size >= MAX_DEDUP_ENTRIES) {
						const oldestKey = lastSeenById.keys().next().value;
						if (oldestKey !== undefined) lastSeenById.delete(oldestKey);
					}
					lastSeenById.set(event.id, { revision: event.revision, token: dedupToken });
					queue.push(event);
				} catch (error) {
					const now = Date.now();
					if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
						lastErrorLogAt = now;
						normalizeError(error, 'subscribe');
					}
				} finally {
					pendingCount -= 1;
				}
			});
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
		return attachToHub(async (raw) => resolveDeliverableEvent(raw, ctx), id);
	}

	if (target?.rest || target?.pathname) throw notFound();
	return attachToHub(async (raw) => resolveDeliverableEvent(raw, ctx));
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

	const queue = await attachToHub(async (raw) => {
		const eventRecord = raw?.value;
		const id = String(raw?.id ?? eventRecord?.id ?? '');
		const kind = eventRecord?.lastEventKind;
		if (!id || !isEventKind(kind)) return undefined;

		// Check in-memory watch/ownership before resolving the subscriber's ScopeGrant or redacting provenance, so
		// unwatched events for other principals do not trigger ScopeGrant or Memory reads.
		const hasFoldedOrDirectFlag =
			kind === 'flagged' || ((kind === 'restored' || kind === 'created') && Boolean(eventRecord?.needsReview));
		const maybeOwnFlagged = hasFoldedOrDirectFlag && (!eventRecord?.ownerId || eventRecord.ownerId === principal.id);
		let watchConfirmed = false;
		if (!maybeOwnFlagged) {
			if (!hasActiveWatch(principal.id, id)) return undefined;
			watchConfirmed = true;
		}

		const deliverable = await resolveDeliverableEvent(raw, ctx);
		if (!deliverable) return undefined;
		const { event, record, currentPrincipal, dedupToken } = deliverable;

		if (
			(event.kind === 'flagged' ||
				((event.kind === 'restored' || event.kind === 'created') && Boolean(record.needsReview))) &&
			record.ownerId === currentPrincipal.id
		) {
			if (event.kind === 'flagged') return { event, dedupToken };
			const [view] = await forReader([toMemoryView(record)], currentPrincipal);
			if (view?.needsReview) return { event, dedupToken };
		}

		if (!watchConfirmed || currentPrincipal.id !== principal.id) {
			if (currentPrincipal.id !== principal.id) {
				await ensurePrincipalWatchesSeeded(currentPrincipal.id);
			}
			if (!hasActiveWatch(currentPrincipal.id, event.id)) return undefined;
		}
		return { event, dedupToken };
	});

	try {
		await ensurePrincipalWatchesSeeded(principal.id);
	} catch (error) {
		queue.close();
		throw error;
	}
	return queue;
}
