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
type MemoryEventKind = (typeof EVENT_KINDS)[number];

interface MemoryEvent {
	id: string;
	kind: MemoryEventKind;
	revision: number;
}

export type SubscriptionStream = AsyncIterable<{
	id: string;
	kind: 'created' | 'revised' | 'superseded' | 'withdrawn' | 'restored' | 'flagged';
	revision: number;
}> & {
	end(): void;
};

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

	get bufferedCount(): number {
		return this.#buffer.length;
	}

	push(event: MemoryEvent): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else if (this.#buffer.length >= MAX_PENDING_EVENTS_PER_LISTENER) {
			logStreamOverflow();
			this.close();
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
const FILTER_STALL_TIMEOUT_MS = 30_000;
const MAX_DEDUP_ENTRIES = 1024;
const WATCH_PRUNE_THRESHOLD = 4096;
const ERROR_LOG_INTERVAL_MS = 60_000;
const PRINCIPAL_CACHE_TTL_MS = 5_000;

let lastOverflowLogAt = 0;
function logStreamOverflow(): void {
	const now = Date.now();
	if (now - lastOverflowLogAt >= ERROR_LOG_INTERVAL_MS) {
		lastOverflowLogAt = now;
		normalizeError(new Error('Subscription stream closed: pending event buffer exceeded 256 events'), 'subscribe');
	}
}

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
const seedingWatchPrincipals = new Map<string, Promise<void>>();
const flagAccessCache = new Map<string, Promise<any>>();

function recordWatchInMemory(principalId: string, memoryId: string, expiresAtMs: number, keepLonger = true): void {
	const now = Date.now();
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return;
	if (!seededWatchPrincipals.has(principalId) && !seedingWatchPrincipals.has(principalId)) return;
	let bucket = watchesByPrincipal.get(principalId);
	if (!bucket) {
		bucket = new Map();
		watchesByPrincipal.set(principalId, bucket);
	}
	const previous = bucket.get(memoryId);
	if (keepLonger && previous !== undefined && previous >= expiresAtMs) return;
	if (previous === undefined && bucket.size >= WATCH_PRUNE_THRESHOLD) {
		for (const [k, exp] of bucket) {
			if (exp <= now) bucket.delete(k);
		}
	}
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

async function ensurePrincipalWatchesSeeded(principalId: string): Promise<void> {
	if (seededWatchPrincipals.has(principalId)) return;
	const existing = seedingWatchPrincipals.get(principalId);
	if (existing) return existing;
	const watchSubAtStart = watchHubSub;
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
			if (watchHubSub && watchHubSub === watchSubAtStart) {
				seededWatchPrincipals.add(principalId);
			}
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
let nextListenerCacheId = 0;

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

async function resolveSubscriberPrincipal(
	authContext: Record<string, unknown>,
	fallbackKey?: string,
): Promise<Principal> {
	const key = harperUserCacheKey(authContext) ?? fallbackKey;
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
	await MemoryWatch.lock(id, { scope: 'node' }, txn);
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
	const sortedIds = [...new Set(ids)].sort();
	if (sortedIds.length === 0) return expiresAt.toISOString();
	const MemoryWatch = memoryWatchTable();
	let earliest: Date | undefined;
	const written: Array<[string, number]> = [];
	await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of sortedIds) {
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
	const sortedIds = [...uniqueIds].sort();
	const Memory = memoryTable();
	const MemoryWatch = memoryWatchTable();
	const written: Array<[string, number]> = [];

	const result = await inOwnTransaction(requestContext, async (txn) => {
		for (const memoryId of sortedIds) {
			const record = await Memory.get(memoryId, txn);
			// Same 404 whether missing or unreadable, so watch cannot probe another principal's memory.
			if (!record || !canRead(record, principal)) throw notFound();
		}
		const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
		let earliest: Date | undefined;
		for (const memoryId of sortedIds) {
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

async function hasVisibleFlag(record: any, principal: Principal): Promise<boolean> {
	if (flagAccessCache.size >= MAX_DEDUP_ENTRIES) flagAccessCache.clear();
	try {
		const [view] = await forReader([toMemoryView(record)], principal, {}, flagAccessCache);
		return Boolean(view?.needsReview);
	} catch (error) {
		flagAccessCache.clear();
		throw error;
	}
}

async function resolveDeliverableEvent(
	raw: any,
	context: Record<string, unknown>,
	listenerCacheKey?: string,
): Promise<DeliverableEvent | undefined> {
	const eventRecord = raw?.value;
	const id = String(raw?.id ?? eventRecord?.id ?? '');
	const kind = eventRecord?.lastEventKind;
	const revision = eventRecord?.revision;
	if (!id || !isEventKind(kind) || typeof revision !== 'number') return undefined;

	const authContext = Object.assign(Object.create(context), {
		user: context.user,
		headers: context.headers,
		transaction: undefined,
		authorize: false,
	});
	let currentPrincipal: Principal;
	try {
		currentPrincipal = await resolveSubscriberPrincipal(authContext, listenerCacheKey);
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
			? canRead({ ownerId: record.ownerId, scopes: record.scopes, contentFlag: record.contentFlag }, currentPrincipal)
			: canRead(record, currentPrincipal);
	if (!readable) return undefined;

	// Whoever can read a content-flagged memory can see its flag.
	if (kind === 'flagged' && !record.contentFlag && !(await hasVisibleFlag(record, currentPrincipal))) {
		return undefined;
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
	flagAccessCache.clear();
	clearPrincipalCache();
	closeUpstreamSub(activeMem);
	closeUpstreamSub(activeWatch);
	closeUpstreamSub(activeGrant);
}

function teardownActiveHub(): void {
	resetHubState();
	const remaining = [...tableListeners, ...[...itemListeners.values()].flatMap((set) => [...set])];
	tableListeners.clear();
	itemListeners.clear();
	for (const listener of remaining) listener.close();
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
		let rawSub: UpstreamSub | undefined;
		let rawWatchSub: UpstreamSub | undefined;
		let rawGrantSub: UpstreamSub | undefined;
		try {
			await null;
			const Memory = memoryTable();
			const MemoryWatch = memoryWatchTable();
			const ScopeGrant = scopeGrantTable();
			const memSub: UpstreamSub = await Memory.subscribe({ omitCurrent: true, includeSuperseded: true }, {});
			rawSub = memSub;
			rawWatchSub =
				typeof MemoryWatch?.subscribe === 'function'
					? await MemoryWatch.subscribe({ omitCurrent: true }, {})
					: undefined;
			rawGrantSub =
				typeof ScopeGrant?.subscribe === 'function' ? await ScopeGrant.subscribe({ omitCurrent: true }, {}) : undefined;
			if (tableListeners.size === 0 && itemListeners.size === 0) {
				closeUpstreamSub(rawSub);
				closeUpstreamSub(rawWatchSub);
				closeUpstreamSub(rawGrantSub);
				return;
			}
			hubSub = memSub;
			watchHubSub = rawWatchSub;
			grantHubSub = rawGrantSub;

			if (rawWatchSub) {
				const watchSub = rawWatchSub;
				void (async () => {
					try {
						for await (const raw of watchSub) {
							if (watchHubSub !== watchSub) break;
							applyWatchEvent(raw);
						}
					} catch (error) {
						if (watchHubSub === watchSub) normalizeError(error, 'subscribe');
					} finally {
						if (watchHubSub === watchSub) {
							teardownActiveHub();
						}
					}
				})();
			}

			if (rawGrantSub) {
				const grantSub = rawGrantSub;
				void (async () => {
					try {
						for await (const _ of grantSub) {
							if (grantHubSub !== grantSub) break;
							clearPrincipalCache();
						}
					} catch (error) {
						if (grantHubSub === grantSub) normalizeError(error, 'subscribe');
					} finally {
						if (grantHubSub === grantSub) {
							teardownActiveHub();
						}
					}
				})();
			}

			void (async () => {
				try {
					for await (const raw of memSub) {
						if (hubSub !== memSub) break;
						const id = String(raw?.id ?? raw?.value?.id ?? '');
						if (id) flagAccessCache.delete(id);
						const byId = id ? itemListeners.get(id) : undefined;
						const snapshot = [...tableListeners, ...(byId ? [...byId] : [])];
						for (const listener of snapshot) {
							listener.enqueue(raw);
						}
					}
				} catch (error) {
					if (hubSub === memSub) normalizeError(error, 'subscribe');
				} finally {
					if (hubSub === memSub) teardownActiveHub();
				}
			})();
		} catch (error) {
			closeUpstreamSub(rawSub);
			closeUpstreamSub(rawWatchSub);
			closeUpstreamSub(rawGrantSub);
			throw error;
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
	filter: (raw: any, listenerCacheKey: string) => Promise<FilteredDelivery | undefined>,
	targetId?: string,
	prefilter?: (raw: any) => boolean,
): Promise<SubscriptionQueue> {
	const listenerCacheKey = `listener:${++nextListenerCacheId}`;
	const lastSeenById = new Map<string, string>();
	let pendingCount = 0;
	let lastFilterProgressAt = Date.now();
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
			if (queue.closed) return;
			const eventRecord = raw?.value;
			const id = String(raw?.id ?? eventRecord?.id ?? '');
			const kind = eventRecord?.lastEventKind;
			const revision = eventRecord?.revision;
			if (!id || !isEventKind(kind) || typeof revision !== 'number') return;
			if (prefilter && !prefilter(raw)) return;
			const now = Date.now();
			if (pendingCount === 0) lastFilterProgressAt = now;
			if (
				queue.bufferedCount >= MAX_PENDING_EVENTS_PER_LISTENER ||
				(pendingCount >= MAX_PENDING_EVENTS_PER_LISTENER && now - lastFilterProgressAt >= FILTER_STALL_TIMEOUT_MS)
			) {
				logStreamOverflow();
				queue.close();
				return;
			}
			pendingCount += 1;
			chain = chain.then(async () => {
				try {
					if (queue.closed) return;
					const delivered = await filter(raw, listenerCacheKey);
					if (!delivered || queue.closed) return;
					const { event, dedupToken } = delivered;
					const previousToken = lastSeenById.get(event.id);
					if (previousToken !== undefined) {
						if (previousToken === dedupToken) return;
						lastSeenById.delete(event.id);
					} else if (lastSeenById.size >= MAX_DEDUP_ENTRIES) {
						const oldestKey = lastSeenById.keys().next().value;
						if (oldestKey !== undefined) lastSeenById.delete(oldestKey);
					}
					lastSeenById.set(event.id, dedupToken);
					queue.push(event);
				} catch (error) {
					const errNow = Date.now();
					if (errNow - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
						lastErrorLogAt = errNow;
						normalizeError(error, 'subscribe');
					}
				} finally {
					pendingCount -= 1;
					lastFilterProgressAt = Date.now();
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
): Promise<SubscriptionStream> {
	const ctx = context as Record<string, unknown>;
	const Memory = memoryTable();

	const rawId = target?.id;
	const isWildcard = rawId === '#' || rawId === '+';
	const hasTargetId = rawId !== undefined && rawId !== null && rawId !== '' && !isWildcard;

	if (hasTargetId) {
		const id = String(rawId);
		const existing = isMemoryId(id) ? await Memory.get(id, ctx) : undefined;
		if (!existing || !canRead(existing, principal)) throw notFound();
		return attachToHub(async (raw, cacheKey) => resolveDeliverableEvent(raw, ctx, cacheKey), id);
	}

	if (target?.rest || target?.pathname) throw notFound();
	return attachToHub(async (raw, cacheKey) => resolveDeliverableEvent(raw, ctx, cacheKey));
}

export async function subscribeMemoryEvents(
	target: any,
	principal: Principal,
	context: object = {},
): Promise<SubscriptionStream> {
	const ctx = context as Record<string, unknown>;
	const rawId = target?.id;
	const isWildcard = rawId === '#' || rawId === '+';
	if (target?.rest || target?.pathname || (rawId !== undefined && rawId !== null && rawId !== '' && !isWildcard)) {
		throw notFound();
	}

	// A write that leaves the owner's memory flagged: `flagged`, a review flag folded into a restore or create, or
	// a create or revise the customer-content check flagged.
	const isFlagEvent = (kind: MemoryEventKind, record: any): boolean =>
		kind === 'flagged' ||
		((kind === 'restored' || kind === 'created') && Boolean(record?.needsReview)) ||
		((kind === 'created' || kind === 'revised') && Boolean(record?.contentFlag));

	const matchesWatchOrOwnFlag = (raw: any): { maybeOwnFlagged: boolean; watchConfirmed: boolean } | undefined => {
		const eventRecord = raw?.value;
		const id = String(raw?.id ?? eventRecord?.id ?? '');
		const kind = eventRecord?.lastEventKind;
		if (!id || !isEventKind(kind)) return undefined;
		const maybeOwnFlagged =
			isFlagEvent(kind, eventRecord) && (!eventRecord?.ownerId || eventRecord.ownerId === principal.id);
		if (maybeOwnFlagged) return { maybeOwnFlagged: true, watchConfirmed: false };
		if (!hasActiveWatch(principal.id, id)) return undefined;
		return { maybeOwnFlagged: false, watchConfirmed: true };
	};

	const queue = await attachToHub(
		async (raw, cacheKey) => {
			await ensurePrincipalWatchesSeeded(principal.id);

			// Check in-memory watch/ownership before resolving the subscriber's ScopeGrant or redacting provenance, so
			// unwatched events for other principals do not trigger ScopeGrant or Memory reads.
			const precheck = matchesWatchOrOwnFlag(raw);
			if (!precheck) return undefined;
			const { watchConfirmed } = precheck;

			const deliverable = await resolveDeliverableEvent(raw, ctx, cacheKey);
			if (!deliverable) return undefined;
			const { event, record, currentPrincipal, dedupToken } = deliverable;

			if (isFlagEvent(event.kind, record) && record.ownerId === currentPrincipal.id) {
				if (event.kind === 'flagged' || record.contentFlag || (await hasVisibleFlag(record, currentPrincipal))) {
					return { event, dedupToken };
				}
			}

			if (!watchConfirmed || currentPrincipal.id !== principal.id) {
				if (currentPrincipal.id !== principal.id) {
					await ensurePrincipalWatchesSeeded(currentPrincipal.id);
				}
				if (!hasActiveWatch(currentPrincipal.id, event.id)) return undefined;
			}
			return { event, dedupToken };
		},
		undefined,
		(raw) => !seededWatchPrincipals.has(principal.id) || Boolean(matchesWatchOrOwnFlag(raw)),
	);

	try {
		await ensurePrincipalWatchesSeeded(principal.id);
	} catch (error) {
		queue.close();
		throw error;
	}
	return queue;
}
