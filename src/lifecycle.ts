// Memory lifecycle, ported from harper-eye's Agent Memory Interface (lib/memory.js). The only writer of the
// Memory table: ownership, scopes, revision, status and timestamps are server-derived, and a payload that
// carries any of them is rejected rather than trimmed, so a caller never believes it set what the server owns.
import { createHash } from 'node:crypto';
import { databases, models, transaction } from 'harper';
import { badRequest, memoryError, notFound } from './errors.ts';
import { assertWritable, canRead, isSuperset, normalizeScopes, type Principal } from './scopes.ts';
import { DEFAULT_EMBEDDING_MODEL, getSettings, type Settings } from './settings.ts';
import { notifySinks } from './sinks.ts';

export const STATUS_ACTIVE = 'active';
export const STATUS_SUPERSEDED = 'superseded';
export const STATUS_WITHDRAWN = 'withdrawn';

export const EVIDENCE_MAX_ITEMS = 20;
export const EVIDENCE_REF_MAX_CHARS = 500;
export const TAGS_MAX_ITEMS = 20;
export const TAG_MAX_CHARS = 64;
export const IDEMPOTENCY_KEY_MAX_CHARS = 200;
export const DURABILITY_MAX_CHARS = 32;
export const WITHDRAW_REASON_MAX_CHARS = 500;
export const SUPERSEDES_MAX_ITEMS = 10;
// Reserved for POST /Memory/import, so a native create can never land on an imported row's id.
export const IMPORT_KEY_PREFIX = 'import:';
const MEMORY_ID = /^[0-9a-f]{32}$/;
// Bounds the reverse lookup when a superseder is withdrawn.
const SUPERSEDER_LOOKUP_LIMIT = 100;

const CREATE_FIELDS = [
	'title',
	'content',
	'tags',
	'scopes',
	'visibility',
	'evidence',
	'pinned',
	'durability',
	'validUntil',
	'idempotencyKey',
	'supersedes',
];
const REVISE_FIELDS = [
	'title',
	'content',
	'tags',
	'scopes',
	'visibility',
	'evidence',
	'pinned',
	'durability',
	'validUntil',
	'expectedRevision',
];
// Narrower than REVISE_FIELDS on purpose: the scopes route changes scopes and nothing else.
const SCOPE_FIELDS = ['scopes', 'visibility', 'expectedRevision'];
const WITHDRAW_FIELDS = ['expectedRevision', 'reason'];

export function memoryTable(): any {
	return (databases as any).memory.Memory;
}

/** Idempotent create: a retry is a primary-key hit, not a secondary-index lookup two retries could both miss. */
export function memoryIdFor(ownerId: string, idempotencyKey: string): string {
	return createHash('sha256').update(`memory:${ownerId}:${idempotencyKey}`).digest('hex').slice(0, 32);
}

export function rejectUnknownFields(
	input: unknown,
	allowed: readonly string[],
	operation: string,
): Record<string, any> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw badRequest(`${operation} payload must be an object`, 'invalid_payload');
	}
	// The field names are not echoed: a caller may have put a secret in one.
	if (Object.keys(input).some((key) => !allowed.includes(key))) {
		throw badRequest(
			`Unsupported field(s) for ${operation}. Owner, revision, status, author and timestamps are server-derived.`,
			'unsupported_fields',
		);
	}
	return input as Record<string, any>;
}

/** `required` governs absence only: a present value is never blank, so a revision cannot erase a title. */
export function boundedText(value: unknown, field: string, maxChars: number, required: boolean): string | undefined {
	if (value === undefined || value === null) {
		if (required) throw badRequest(`${field} is required`, `${field}_required`);
		return undefined;
	}
	if (typeof value !== 'string') throw badRequest(`${field} must be a string`, `invalid_${field}`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw badRequest(`${field} must not be empty`, `${field}_required`);
	if (trimmed.length > maxChars) throw badRequest(`${field} exceeds ${maxChars} characters`, `${field}_too_long`);
	return trimmed;
}

function boundedStrings(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
	if (!Array.isArray(value)) throw badRequest(`${field} must be an array of strings`, `invalid_${field}`);
	if (value.length > maxItems) throw badRequest(`${field} exceeds ${maxItems} items`, `${field}_too_many`);
	return value.map((item, i) => {
		if (typeof item !== 'string' || item.trim().length === 0) {
			throw badRequest(`${field}[${i}] must be a non-empty string`, `invalid_${field}`);
		}
		const trimmed = item.trim();
		if (trimmed.length > maxChars)
			throw badRequest(`${field}[${i}] exceeds ${maxChars} characters`, `${field}_too_long`);
		return trimmed;
	});
}

/** Evidence holds bounded references (ticket ids, URLs, run ids), not fetched payloads or credentials. */
export function normalizeEvidence(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	return boundedStrings(value, 'evidence', EVIDENCE_MAX_ITEMS, EVIDENCE_REF_MAX_CHARS);
}

export function normalizeTags(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	return [...new Set(boundedStrings(value, 'tags', TAGS_MAX_ITEMS, TAG_MAX_CHARS))];
}

export function normalizeIds(value: unknown, field: string, maxItems: number): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && MEMORY_ID.test(id))) {
		throw badRequest(`${field} must be an array of memory ids`, `invalid_${field}`);
	}
	if (value.length > maxItems) throw badRequest(`${field} exceeds ${maxItems} ids`, `${field}_too_many`);
	return [...new Set(value as string[])];
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === 'string' && MEMORY_ID.test(value);
}

export function optionalDate(value: unknown, field: string): Date | undefined {
	if (value === undefined || value === null) return undefined;
	const date = typeof value === 'string' || value instanceof Date ? new Date(value) : undefined;
	if (!date || Number.isNaN(date.getTime())) throw badRequest(`${field} must be an ISO date`, `invalid_${field}`);
	return date;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') throw badRequest(`${field} must be a boolean`, `invalid_${field}`);
	return value;
}

function requireExpectedRevision(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw badRequest('expectedRevision must be a positive integer', 'expected_revision_required');
	}
	return value as number;
}

/**
 * Fingerprint of the original create request. Revisions never touch it, so a late retry of the first create
 * still matches and returns the current record instead of reading as a conflicting key reuse.
 */
export function fingerprint(fields: unknown[]): string {
	return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value ?? null));

export interface MemoryView extends Record<string, unknown> {
	id: string;
	title: string | null;
	content: string;
}

/** The caller-facing shape. Leaves out the vector, the fingerprint and the idempotency key. */
export function toMemoryView(record: any): MemoryView {
	return {
		id: record.id,
		title: record.title ?? null,
		content: record.content,
		tags: [...(record.tags ?? [])],
		scopes: [...(record.scopes ?? [])],
		ownerId: record.ownerId,
		status: record.status,
		revision: record.revision,
		pinned: record.pinned === true,
		durability: record.durability ?? null,
		evidence: [...(record.evidence ?? [])],
		supersedes: [...(record.supersedes ?? [])],
		supersededBy: record.supersededBy ?? null,
		author: record.author ?? null,
		lastEditor: record.lastEditor ?? null,
		validUntil: iso(record.validUntil),
		withdrawnAt: iso(record.withdrawnAt),
		withdrawnReason: record.withdrawnReason ?? null,
		createdAt: iso(record.createdAt),
		updatedAt: iso(record.updatedAt),
	};
}

const embedderInstalled = new WeakSet<object>();

// The row's own `embeddingModel` names the model, so the vector and the tag the vector lane filters on are
// always from the same write.
async function embedWithRecordModel(record: any, hook?: { signal?: AbortSignal }) {
	if (record.content == null) return null;
	const [vector] = await models.embed(String(record.content), {
		model: record.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
		inputType: 'document',
		signal: hook?.signal,
	});
	return vector ? Array.from(vector) : undefined;
}

/** The schema's @embed hook already uses "default"; any other model needs the per-table override. */
export function ensureEmbedder(Memory: any, settings: Settings): void {
	if (settings.embeddingModel === DEFAULT_EMBEDDING_MODEL || embedderInstalled.has(Memory)) return;
	Memory.setEmbedAttribute('embedding', embedWithRecordModel);
	embedderInstalled.add(Memory);
}

/**
 * Serializes read-check-write against every other lifecycle operation on the same rows. Harper's record lock
 * excludes other lock() callers, and this plugin is the only writer of Memory. Sorted to keep a consistent
 * acquisition order across operations that lock several rows.
 */
export async function lockRows(Memory: any, ids: Iterable<string>, context: object): Promise<void> {
	for (const id of [...new Set(ids)].sort()) await Memory.lock(id, {}, context);
}

/**
 * Each lifecycle operation commits or aborts on its own. Joining the request's transaction would let an error
 * the resource turns into a response commit whatever had been staged before it. The new context carries the
 * user so Harper's audit log still attributes the write.
 */
export function inOwnTransaction<T>(requestContext: any, operation: (context: object) => Promise<T>): Promise<T> {
	const context = { user: requestContext?.user };
	return transaction(context, () => operation(context)) as Promise<T>;
}

export async function getMemory(id: string, principal: Principal, context?: object) {
	const record = isMemoryId(id) ? await memoryTable().get(id, context) : undefined;
	if (!record || !canRead(record, principal)) return undefined;
	return toMemoryView(record);
}

export async function createMemory(input: unknown, principal: Principal, requestContext: object) {
	const settings = getSettings();
	const payload = rejectUnknownFields(input, CREATE_FIELDS, 'create');
	// All validation runs before the transaction, so an invalid request never writes and then fails.
	const idempotencyKey = boundedText(payload.idempotencyKey, 'idempotencyKey', IDEMPOTENCY_KEY_MAX_CHARS, true)!;
	if (idempotencyKey.startsWith(IMPORT_KEY_PREFIX)) {
		throw badRequest(`idempotencyKey must not start with "${IMPORT_KEY_PREFIX}"`, 'reserved_idempotency_key');
	}
	const scopes = normalizeScopes(payload.scopes, payload.visibility, principal.id);
	assertWritable(scopes, principal);
	const title = boundedText(payload.title, 'title', settings.titleChars, true);
	const content = boundedText(payload.content, 'content', settings.contentChars, true);
	const tags = normalizeTags(payload.tags);
	const evidence = normalizeEvidence(payload.evidence);
	const pinned = optionalBoolean(payload.pinned, 'pinned') ?? false;
	const durability = boundedText(payload.durability, 'durability', DURABILITY_MAX_CHARS, false);
	const validUntil = optionalDate(payload.validUntil, 'validUntil');
	const supersedes = normalizeIds(payload.supersedes, 'supersedes', SUPERSEDES_MAX_ITEMS);

	const id = memoryIdFor(principal.id, idempotencyKey);
	const createFingerprint = fingerprint([
		title,
		content,
		tags,
		scopes,
		evidence,
		pinned,
		durability ?? null,
		iso(validUntil),
		supersedes,
	]);
	const Memory = memoryTable();
	ensureEmbedder(Memory, settings);

	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(Memory, [id, ...supersedes], txn);
		const existing = await Memory.get(id, txn);
		if (existing) {
			if (existing.createFingerprint !== createFingerprint) {
				throw memoryError(
					'Idempotency key already used by this principal with a different payload',
					409,
					'idempotency_conflict',
				);
			}
			return { memory: toMemoryView(existing), created: false };
		}

		const targets = [];
		for (const targetId of supersedes) {
			const target = await Memory.get(targetId, txn);
			// Same 404 as a missing id, so supersedes is not a probe for another principal's memory.
			if (!target || !canRead(target, principal)) throw notFound();
			if (target.status === STATUS_WITHDRAWN) throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
			if (!isSuperset(scopes, target.scopes ?? [])) {
				throw memoryError(
					'A superseding memory must carry every scope label of the memory it supersedes',
					403,
					'supersede_scope_narrowing',
				);
			}
			targets.push(target);
		}

		const now = new Date();
		await Memory.put(
			{
				id,
				title,
				content,
				tags,
				scopes,
				ownerId: principal.id,
				status: STATUS_ACTIVE,
				revision: 1,
				pinned,
				durability: durability ?? null,
				evidence,
				supersedes,
				supersededBy: null,
				idempotencyKey,
				createdAt: now,
				createFingerprint,
				author: { principalId: principal.id, source: principal.source, authoredAt: now.toISOString() },
				lastEditor: null,
				validUntil: validUntil ?? null,
				withdrawnAt: null,
				withdrawnReason: null,
				embeddingModel: settings.embeddingModel,
			},
			txn,
		);
		for (const target of targets) {
			await Memory.patch(
				target.id,
				{ status: STATUS_SUPERSEDED, supersededBy: id, revision: target.revision + 1 },
				txn,
			);
		}
		// Re-read inside the transaction: @updatedTime is applied by the database.
		const memory = toMemoryView(await Memory.get(id, txn));
		await notifySinks('write', memory, txn);
		for (const target of targets) await notifySinks('write', toMemoryView(await Memory.get(target.id, txn)), txn);
		return { memory, created: true };
	});
}

type Mutator = (existing: any) => Record<string, any>;

async function mutateMemory(
	id: unknown,
	principal: Principal,
	expectedRevision: unknown,
	requestContext: object,
	operation: 'revise' | 'withdraw',
	mutate: Mutator,
) {
	const settings = getSettings();
	const revision = requireExpectedRevision(expectedRevision);
	if (!isMemoryId(id)) throw notFound();
	const Memory = memoryTable();
	ensureEmbedder(Memory, settings);

	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(Memory, [id], txn);
		const existing = await Memory.get(id, txn);
		if (!existing) throw notFound();
		// A caller that cannot read the memory gets the same 404 as a missing one, so a write attempt does not
		// confirm another principal's memory exists. One that can read it gets an informative 403.
		if (existing.ownerId !== principal.id && !principal.superUser) {
			if (!canRead(existing, principal)) throw notFound();
			throw memoryError('Only the owner can modify this memory', 403, 'not_memory_owner');
		}
		if (existing.status === STATUS_WITHDRAWN) throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
		// Frozen, so `replacement.scopes ⊇ superseded.scopes` keeps holding after the supersede, not only at it.
		if (existing.status === STATUS_SUPERSEDED && operation !== 'withdraw') {
			throw memoryError('Memory has been superseded', 409, 'memory_superseded');
		}
		if (existing.revision !== revision) {
			throw memoryError(
				`Stale write: expected revision ${revision} but current revision is ${existing.revision}`,
				409,
				'revision_conflict',
			);
		}

		const changes = mutate(existing);
		if (operation !== 'withdraw') {
			// The resulting scopes, not only changed ones: revising a memory that stays global keeps publishing
			// it globally. Withdrawal is exempt — locking an owner out of retracting would be worse.
			const scopes = changes.scopes ?? existing.scopes;
			assertWritable(scopes, principal);
			if (changes.scopes) await assertStillCoversSuperseded(Memory, existing, changes.scopes, txn);
			if (changes.content !== undefined) changes.embeddingModel = settings.embeddingModel;
		}
		changes.revision = existing.revision + 1;
		if (operation !== 'withdraw') {
			changes.lastEditor = { principalId: principal.id, source: principal.source, revisedAt: new Date().toISOString() };
		}

		const restored = operation === 'withdraw' ? await reconcileSuperseded(Memory, existing, txn) : [];
		// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
		await Memory.patch(existing.id, changes, txn);
		const memory = toMemoryView(await Memory.get(existing.id, txn));
		await notifySinks(operation === 'withdraw' ? 'withdraw' : 'write', memory, txn);
		for (const targetId of restored) await notifySinks('write', toMemoryView(await Memory.get(targetId, txn)), txn);
		return memory;
	});
}

async function assertStillCoversSuperseded(Memory: any, existing: any, scopes: string[], context: object) {
	for (const targetId of existing.supersedes ?? []) {
		const target = await Memory.get(targetId, context);
		if (target && target.status !== STATUS_WITHDRAWN && !isSuperset(scopes, target.scopes ?? [])) {
			throw memoryError(
				'A memory must keep every scope label of the memories it supersedes',
				403,
				'supersede_scope_narrowing',
			);
		}
	}
}

/**
 * Withdrawing W: each memory W superseded stays superseded while any other non-withdrawn memory lists it in
 * `supersedes` (newest wins `supersededBy`), and returns to active otherwise. A superseder that has itself
 * been superseded still counts — its replacement carries the chain forward. Runs before W is patched, under
 * the targets' locks, which every create that supersedes them also takes. Returns the ids it changed.
 */
async function reconcileSuperseded(Memory: any, withdrawn: any, context: object): Promise<string[]> {
	const targetIds: string[] = withdrawn.supersedes ?? [];
	if (targetIds.length === 0) return [];
	await lockRows(Memory, targetIds, context);
	const changed: string[] = [];
	for (const targetId of targetIds) {
		const target = await Memory.get(targetId, context);
		if (target?.status !== STATUS_SUPERSEDED) continue;
		let newest: any;
		for await (const holder of Memory.search(
			{
				conditions: [{ attribute: 'supersedes', comparator: 'equals', value: targetId }],
				select: ['id', 'status', 'createdAt'],
				limit: SUPERSEDER_LOOKUP_LIMIT,
			},
			context,
		)) {
			if (holder.id === withdrawn.id || holder.status === STATUS_WITHDRAWN) continue;
			if (!newest || compareNewest(holder, newest) > 0) newest = holder;
		}
		const next = newest
			? { status: STATUS_SUPERSEDED, supersededBy: newest.id }
			: { status: STATUS_ACTIVE, supersededBy: null };
		if (next.status === target.status && next.supersededBy === target.supersededBy) continue;
		await Memory.patch(targetId, { ...next, revision: target.revision + 1 }, context);
		changed.push(targetId);
	}
	return changed;
}

function compareNewest(a: any, b: any): number {
	const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
	return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Omitting `scopes`/`visibility` keeps the stored scopes; supplying either is the explicit scope change. */
export async function reviseMemory(id: unknown, input: unknown, principal: Principal, context: object) {
	const settings = getSettings();
	const payload = rejectUnknownFields(input, REVISE_FIELDS, 'revise');
	const title = boundedText(payload.title, 'title', settings.titleChars, false);
	const content = boundedText(payload.content, 'content', settings.contentChars, false);
	const tags = payload.tags === undefined ? undefined : normalizeTags(payload.tags);
	const evidence = payload.evidence === undefined ? undefined : normalizeEvidence(payload.evidence);
	const pinned = optionalBoolean(payload.pinned, 'pinned');
	const durability = boundedText(payload.durability, 'durability', DURABILITY_MAX_CHARS, false);
	const validUntil = optionalDate(payload.validUntil, 'validUntil');
	const scopesRequested = payload.scopes != null || payload.visibility != null;
	const scopes = scopesRequested ? normalizeScopes(payload.scopes, payload.visibility, principal.id) : undefined;
	const changes: Record<string, any> = {
		...(title !== undefined && { title }),
		...(content !== undefined && { content }),
		...(tags !== undefined && { tags }),
		...(evidence !== undefined && { evidence }),
		...(pinned !== undefined && { pinned }),
		...(durability !== undefined && { durability }),
		...(validUntil !== undefined && { validUntil }),
	};
	if (Object.keys(changes).length === 0 && !scopes) {
		throw badRequest('revise requires at least one field to change', 'empty_revision');
	}
	return mutateMemory(id, principal, payload.expectedRevision, context, 'revise', (existing) => {
		// A private shorthand resolves against the owner, not a super_user editing on their behalf.
		const resolved =
			scopes && payload.scopes == null ? normalizeScopes(undefined, payload.visibility, existing.ownerId) : scopes;
		return resolved ? { ...changes, scopes: resolved } : { ...changes };
	});
}

export async function setMemoryScopes(id: unknown, input: unknown, principal: Principal, context: object) {
	// Validate the whole payload before narrowing it, so a forged field cannot be laundered into a revise.
	const payload = rejectUnknownFields(input, SCOPE_FIELDS, 'scopes');
	if (payload.scopes == null && payload.visibility == null) {
		throw badRequest('scopes or visibility is required', 'invalid_scopes');
	}
	return reviseMemory(
		id,
		{ scopes: payload.scopes, visibility: payload.visibility, expectedRevision: payload.expectedRevision },
		principal,
		context,
	);
}

/** The row is kept as a tombstone, never deleted, so a sink can retract its copy. */
export async function withdrawMemory(id: unknown, input: unknown, principal: Principal, context: object) {
	const payload = rejectUnknownFields(input, WITHDRAW_FIELDS, 'withdraw');
	const reason = boundedText(payload.reason, 'reason', WITHDRAW_REASON_MAX_CHARS, false);
	return mutateMemory(id, principal, payload.expectedRevision, context, 'withdraw', () => ({
		status: STATUS_WITHDRAWN,
		withdrawnAt: new Date(),
		withdrawnReason: reason ?? null,
	}));
}
