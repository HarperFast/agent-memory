import { createHash } from 'node:crypto';
import { databases, models, transaction } from 'harper';
import { badRequest, memoryError, notFound } from './errors.ts';
import { assertWritable, canRead, isSuperset, normalizeScopes, type Principal } from './scopes.ts';
import { DEFAULT_EMBEDDING_MODEL, getSettings, type Settings } from './settings.ts';
import { hasSinks, notifySinks } from './sinks.ts';

export const STATUS_ACTIVE = 'active';
export const STATUS_SUPERSEDED = 'superseded';
export const STATUS_WITHDRAWN = 'withdrawn';

export const EVIDENCE_MAX_ITEMS = 20;
export const EVIDENCE_REF_MAX_CHARS = 500;
export const EVIDENCE_NOTE_MAX_CHARS = 500;
export const EVIDENCE_KINDS = ['memory', 'doc', 'pr', 'commit', 'url', 'text'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export interface EvidenceItem {
	kind: EvidenceKind;
	ref: string;
	note?: string;
}
export const TAGS_MAX_ITEMS = 20;
export const TAG_MAX_CHARS = 64;
export const IDEMPOTENCY_KEY_MAX_CHARS = 200;
export const WITHDRAW_REASON_MAX_CHARS = 500;
export const SUPERSEDES_MAX_ITEMS = 10;
// Reserved for POST /Memory/import, so a native create can never land on an imported row's id.
export const IMPORT_KEY_PREFIX = 'import:';
const MEMORY_ID = /^[0-9a-f]{32}$/;

const CREATE_FIELDS = [
	'title',
	'content',
	'tags',
	'scopes',
	'visibility',
	'evidence',
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
	'validUntil',
	'expectedRevision',
];
const SCOPE_FIELDS = ['scopes', 'visibility', 'expectedRevision'];
const WITHDRAW_FIELDS = ['expectedRevision', 'reason'];
const EVIDENCE_FIELDS = ['kind', 'ref', 'note'];

export function memoryTable(): any {
	return (databases as any).memory.Memory;
}

export function memoryPinTable(): any {
	return (databases as any).memory.MemoryPin;
}

export function memoryPinIdFor(principalId: string, memoryId: string): string {
	return `${principalId}:${memoryId}`;
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

/** Evidence holds bounded typed references (memories, docs, PRs, commits, URLs, short text), not fetched payloads or credentials. */
export function normalizeEvidence(value: unknown): EvidenceItem[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw badRequest('evidence must be an array of evidence items', 'invalid_evidence');
	if (value.length > EVIDENCE_MAX_ITEMS) {
		throw badRequest(`evidence exceeds ${EVIDENCE_MAX_ITEMS} items`, 'evidence_too_many');
	}
	return value.map((raw, i) => {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			throw badRequest(`evidence[${i}] must be an object`, 'invalid_evidence');
		}
		const item = raw as Record<string, unknown>;
		if (Object.keys(item).some((key) => !EVIDENCE_FIELDS.includes(key))) {
			throw badRequest(`evidence[${i}] has unsupported field(s)`, 'invalid_evidence');
		}
		if (typeof item.kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(item.kind)) {
			throw badRequest(`evidence[${i}].kind must be one of: ${EVIDENCE_KINDS.join(', ')}`, 'invalid_evidence');
		}
		if (typeof item.ref !== 'string' || item.ref.trim().length === 0) {
			throw badRequest(`evidence[${i}].ref must be a non-empty string`, 'invalid_evidence');
		}
		const ref = item.ref.trim();
		if (ref.length > EVIDENCE_REF_MAX_CHARS) {
			throw badRequest(`evidence[${i}].ref exceeds ${EVIDENCE_REF_MAX_CHARS} characters`, 'evidence_too_long');
		}
		if (item.kind === 'memory' && !isMemoryId(ref)) {
			throw badRequest('Referenced evidence memory is not readable', 'invalid_evidence');
		}
		if (item.note === undefined || item.note === null) {
			return { kind: item.kind as EvidenceKind, ref };
		}
		if (typeof item.note !== 'string' || item.note.trim().length === 0) {
			throw badRequest(`evidence[${i}].note must be a non-empty string`, 'invalid_evidence');
		}
		const note = item.note.trim();
		if (note.length > EVIDENCE_NOTE_MAX_CHARS) {
			throw badRequest(`evidence[${i}].note exceeds ${EVIDENCE_NOTE_MAX_CHARS} characters`, 'evidence_too_long');
		}
		return { kind: item.kind as EvidenceKind, ref, note };
	});
}

export function deriveEvidenceMemoryIds(evidence: readonly EvidenceItem[]): string[] {
	return [...new Set(evidence.filter((item) => item.kind === 'memory').map((item) => item.ref))];
}

async function assertReadableEvidence(
	Memory: any,
	evidenceMemoryIds: readonly string[],
	principal: Principal,
	context: object,
): Promise<void> {
	for (const refId of evidenceMemoryIds) {
		const target = await Memory.get(refId, context);
		// Same 400 whether missing or unreadable, so citing cannot probe another principal's memory.
		if (!target || !canRead(target, principal)) {
			throw badRequest('Referenced evidence memory is not readable', 'invalid_evidence');
		}
	}
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
		evidence: (record.evidence ?? []).map((item: any) => ({ ...item })),
		evidenceMemoryIds: [...(record.evidenceMemoryIds ?? [])],
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
 * Serializes read-check-write against every other lifecycle operation on the same rows: Harper's record lock
 * excludes other lock() callers, and this plugin is the only writer of Memory. Sorted so operations that lock
 * several rows acquire them in one global order. Node scope, because a cluster-scoped lock on a replicated
 * database fails closed unless the cluster has opted into replicated record locks; across nodes, concurrent
 * revisions are therefore not serialized (replication keeps the later write).
 */
export async function lockRows(Memory: any, ids: Iterable<string>, context: object, lease?: number): Promise<void> {
	const options = lease ? { scope: 'node', lease } : { scope: 'node' };
	for (const id of [...new Set(ids)].sort()) await Memory.lock(id, options, context);
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
	const evidenceMemoryIds = deriveEvidenceMemoryIds(evidence);
	const validUntil = optionalDate(payload.validUntil, 'validUntil');
	const supersedes = normalizeIds(payload.supersedes, 'supersedes', SUPERSEDES_MAX_ITEMS);

	const id = memoryIdFor(principal.id, idempotencyKey);
	const createFingerprint = fingerprint([title, content, tags, scopes, evidence, iso(validUntil), supersedes]);
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

		await assertReadableEvidence(Memory, evidenceMemoryIds, principal, txn);
		const now = new Date();
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
			// The newest superseder wins the pointer, which is not necessarily this one: an imported superseder can
			// carry a later createdAt, and two creates can share a millisecond.
			const current = await newestSuperseder(Memory, targetId, txn);
			const supersededBy = current && compareNewest(current, { id, createdAt: now }) > 0 ? current.id : id;
			targets.push({ target, supersededBy });
		}

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
				evidence,
				evidenceMemoryIds,
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
		for (const { target, supersededBy } of targets) {
			await Memory.patch(target.id, { status: STATUS_SUPERSEDED, supersededBy, revision: target.revision + 1 }, txn);
		}
		// Re-read inside the transaction: @updatedTime is applied by the database.
		const memory = toMemoryView(await Memory.get(id, txn));
		if (hasSinks()) {
			await notifySinks('write', memory, txn);
			for (const { target } of targets) await notifySinks('write', toMemoryView(await Memory.get(target.id, txn)), txn);
		}
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
		// A withdrawal also changes the memories it superseded. `supersedes` never changes after create, so an
		// unlocked read can plan the whole lock set, taken once in sorted order like every other operation.
		const planned = operation === 'withdraw' ? await Memory.get(id, txn) : undefined;
		await lockRows(Memory, [id, ...(planned?.supersedes ?? [])], txn);
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
			if (changes.evidenceMemoryIds) await assertReadableEvidence(Memory, changes.evidenceMemoryIds, principal, txn);
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
		if (hasSinks()) {
			await notifySinks(operation === 'withdraw' ? 'withdraw' : 'write', memory, txn);
			for (const targetId of restored) await notifySinks('write', toMemoryView(await Memory.get(targetId, txn)), txn);
		}
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
 * The newest non-withdrawn memory that lists `targetId` in `supersedes`, ignoring `excludeId`. A superseder that
 * has itself been superseded still counts: its replacement carries the chain forward.
 */
export async function newestSuperseder(Memory: any, targetId: string, context: object, excludeId?: string) {
	let newest: any;
	for await (const holder of Memory.search(
		{
			conditions: [
				{ attribute: 'supersedes', comparator: 'equals', value: targetId },
				{
					operator: 'or',
					conditions: [
						{ attribute: 'status', comparator: 'equals', value: STATUS_ACTIVE },
						{ attribute: 'status', comparator: 'equals', value: STATUS_SUPERSEDED },
					],
				},
			],
			sort: { attribute: 'createdAt', descending: true },
			select: ['id', 'createdAt'],
		},
		context,
	)) {
		if (holder.id === excludeId) continue;
		// Newest first, so only a tie with the newest can still change the answer.
		if (newest && new Date(holder.createdAt).getTime() < new Date(newest.createdAt).getTime()) break;
		if (!newest || compareNewest(holder, newest) > 0) newest = holder;
	}
	return newest;
}

export function compareNewest(a: { id: string; createdAt: unknown }, b: { id: string; createdAt: unknown }): number {
	const delta = new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime();
	return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Withdrawing W: each memory W superseded stays superseded while another non-withdrawn memory supersedes it, and
 * returns to active otherwise. Runs before W is patched, with the targets already locked by the caller; every
 * create that supersedes them takes the same locks. Returns the ids it changed.
 */
async function reconcileSuperseded(Memory: any, withdrawn: any, context: object): Promise<string[]> {
	const changed: string[] = [];
	for (const targetId of withdrawn.supersedes ?? []) {
		const target = await Memory.get(targetId, context);
		if (target?.status !== STATUS_SUPERSEDED) continue;
		const newest = await newestSuperseder(Memory, targetId, context, withdrawn.id);
		const next = newest
			? { status: STATUS_SUPERSEDED, supersededBy: newest.id }
			: { status: STATUS_ACTIVE, supersededBy: null };
		if (next.status === target.status && next.supersededBy === target.supersededBy) continue;
		await Memory.patch(targetId, { ...next, revision: target.revision + 1 }, context);
		changed.push(targetId);
	}
	return changed;
}

/** Omitting `scopes`/`visibility` keeps the stored scopes; supplying either is the explicit scope change. */
export async function reviseMemory(id: unknown, input: unknown, principal: Principal, context: object) {
	const settings = getSettings();
	const payload = rejectUnknownFields(input, REVISE_FIELDS, 'revise');
	const title = boundedText(payload.title, 'title', settings.titleChars, false);
	const content = boundedText(payload.content, 'content', settings.contentChars, false);
	const tags = payload.tags === undefined ? undefined : normalizeTags(payload.tags);
	const evidence = payload.evidence === undefined ? undefined : normalizeEvidence(payload.evidence);
	const evidenceMemoryIds = evidence === undefined ? undefined : deriveEvidenceMemoryIds(evidence);
	const validUntil = optionalDate(payload.validUntil, 'validUntil');
	const scopesRequested = payload.scopes != null || payload.visibility != null;
	const scopes = scopesRequested ? normalizeScopes(payload.scopes, payload.visibility, principal.id) : undefined;
	const changes: Record<string, any> = {
		...(title !== undefined && { title }),
		...(content !== undefined && { content }),
		...(tags !== undefined && { tags }),
		...(evidence !== undefined && { evidence, evidenceMemoryIds }),
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

export async function pinMemory(id: unknown, input: unknown = {}, principal: Principal, requestContext: object = {}) {
	rejectUnknownFields(input, [], 'pin');
	if (!isMemoryId(id)) throw notFound();
	const Memory = memoryTable();
	const MemoryPin = memoryPinTable();
	const pinId = memoryPinIdFor(principal.id, id);
	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(MemoryPin, [pinId], txn);
		const record = await Memory.get(id, txn);
		// Same 404 whether missing or unreadable, so pinning cannot probe another principal's memory.
		if (!record || !canRead(record, principal)) throw notFound();
		const existing = await MemoryPin.get(pinId, txn);
		if (!existing) {
			await MemoryPin.put(
				{
					id: pinId,
					principalId: principal.id,
					memoryId: id,
					createdAt: new Date(),
				},
				txn,
			);
		}
		return { pinned: true, memoryId: id, memory: toMemoryView(record) };
	});
}

export async function unpinMemory(id: unknown, input: unknown = {}, principal: Principal, requestContext: object = {}) {
	rejectUnknownFields(input, [], 'unpin');
	if (!isMemoryId(id)) throw notFound();
	const Memory = memoryTable();
	const MemoryPin = memoryPinTable();
	const pinId = memoryPinIdFor(principal.id, id);
	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(MemoryPin, [pinId], txn);
		const record = await Memory.get(id, txn);
		if (!record || !canRead(record, principal)) throw notFound();
		await MemoryPin.delete(pinId, txn);
		return { pinned: false, memoryId: id, memory: toMemoryView(record) };
	});
}
