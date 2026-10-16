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
const TAGS_MAX_ITEMS = 20;
const TAG_MAX_CHARS = 64;
export const WITHDRAW_REASON_MAX_CHARS = 500;
const SUPERSEDES_MAX_ITEMS = 10;
export const BOOTSTRAP_PINNED_LIMIT = 50;
const MEMORY_ID = /^[A-Za-z0-9_-]{16,64}$/;

const PUT_FIELDS = ['title', 'content', 'tags', 'scopes', 'visibility', 'evidence', 'validUntil', 'supersedes'];
const WITHDRAW_FIELDS = ['reason'];
const EVIDENCE_FIELDS = ['kind', 'ref', 'note'];

export function memoryTable(): any {
	return (databases as any).memory.Memory;
}

export function memoryPinTable(): any {
	return (databases as any).memory.MemoryPin;
}

function memoryPinIdFor(principalId: string, memoryId: string): string {
	return `${principalId}:${memoryId}`;
}

function getHeader(context: any, name: string): string | undefined {
	const headers = context?.headers ?? context?.request?.headers;
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	if (typeof headers.get === 'function') {
		const value = headers.get(name) ?? headers.get(lower);
		if (typeof value === 'string') return value.trim() || undefined;
	}
	const objectHeaders = headers.asObject && typeof headers.asObject === 'object' ? headers.asObject : headers;
	if (typeof objectHeaders === 'object') {
		for (const [key, value] of Object.entries(objectHeaders)) {
			if (key.toLowerCase() === lower && typeof value === 'string') return value.trim() || undefined;
		}
	}
	return undefined;
}

function matchesIfMatch(header: string, revision: number): boolean {
	const expected = `"${revision}"`;
	return header
		.split(',')
		.map((part) => part.trim())
		.some((part) => part === '*' || part === expected);
}

function matchesIfNoneMatch(header: string, revision: number): boolean {
	const expected = `"${revision}"`;
	return header
		.split(',')
		.map((part) => part.trim())
		.some((part) => part === '*' || part === expected || part === `W/${expected}`);
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameEvidence(a: readonly EvidenceItem[], b: readonly EvidenceItem[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(item, i) =>
				item.kind === b[i].kind && item.ref === b[i].ref && (item.note ?? undefined) === (b[i].note ?? undefined),
		)
	);
}

export function sameEditableFields(
	existing: any,
	candidate: {
		title: string | null | undefined;
		content: string | undefined;
		tags: readonly string[];
		scopes: readonly string[];
		evidence: readonly EvidenceItem[];
		validUntil: unknown;
	},
): boolean {
	return (
		(existing.title ?? null) === candidate.title &&
		existing.content === candidate.content &&
		sameStringArray(existing.tags ?? [], candidate.tags) &&
		sameStringArray(existing.scopes ?? [], candidate.scopes) &&
		sameEvidence(existing.evidence ?? [], candidate.evidence) &&
		iso(existing.validUntil) === iso(candidate.validUntil)
	);
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
	return [...new Set(boundedStrings(value, 'tags', TAGS_MAX_ITEMS, TAG_MAX_CHARS))].sort();
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

export async function putMemory(id: unknown, input: unknown, principal: Principal, requestContext: object = {}) {
	if (!isMemoryId(id)) {
		throw badRequest('id must be 16-64 URL-safe characters (^[A-Za-z0-9_-]{16,64}$)', 'invalid_id');
	}
	const settings = getSettings();
	const payload = rejectUnknownFields(input, PUT_FIELDS, 'put');
	if (Object.keys(payload).length === 0) {
		throw badRequest('put payload must not be empty', 'empty_payload');
	}
	if (payload.scopes === null) throw badRequest('scopes must be a non-empty array of scope labels', 'invalid_scopes');
	if (payload.visibility === null) {
		throw badRequest('visibility must be one of: private, shared', 'invalid_visibility');
	}
	const parsedTitle = boundedText(payload.title, 'title', settings.titleChars, false);
	const parsedContent = boundedText(payload.content, 'content', settings.contentChars, false);
	const parsedTags = payload.tags === undefined ? undefined : normalizeTags(payload.tags);
	const parsedEvidence = payload.evidence === undefined ? undefined : normalizeEvidence(payload.evidence);
	const parsedEvidenceMemoryIds = parsedEvidence === undefined ? undefined : deriveEvidenceMemoryIds(parsedEvidence);
	const parsedValidUntil =
		payload.validUntil === undefined
			? undefined
			: payload.validUntil === null
				? null
				: optionalDate(payload.validUntil, 'validUntil');
	const supersedes = normalizeIds(payload.supersedes, 'supersedes', SUPERSEDES_MAX_ITEMS);
	if (supersedes.includes(id)) {
		throw badRequest('A memory cannot supersede itself', 'self_supersede');
	}
	const scopesRequested = payload.scopes != null || payload.visibility != null;

	const ifMatch = getHeader(requestContext, 'if-match');
	const ifNoneMatch = getHeader(requestContext, 'if-none-match');

	const Memory = memoryTable();
	ensureEmbedder(Memory, settings);

	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(Memory, [id, ...supersedes], txn);
		const existing = await Memory.get(id, txn);
		if (existing) {
			if (existing.ownerId !== principal.id && !principal.superUser) {
				if (!canRead(existing, principal)) {
					throw memoryError('Memory id is not available', 409, 'id_unavailable');
				}
				throw memoryError('Only the owner can modify this memory', 403, 'not_memory_owner');
			}
			if (ifNoneMatch !== undefined && matchesIfNoneMatch(ifNoneMatch, existing.revision)) {
				throw memoryError('Precondition failed: memory already exists', 412, 'precondition_failed');
			}
			if (existing.status === STATUS_WITHDRAWN) {
				throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
			}

			// A private shorthand on an existing memory resolves against the owner, not a super_user editing on their behalf.
			const resolvedScopes = scopesRequested
				? payload.scopes == null
					? normalizeScopes(undefined, payload.visibility, existing.ownerId)
					: normalizeScopes(payload.scopes, payload.visibility, existing.ownerId)
				: ifMatch !== undefined
					? (existing.scopes ?? [])
					: normalizeScopes(undefined, undefined, existing.ownerId);

			const candidate = {
				title: parsedTitle !== undefined ? parsedTitle : ifMatch !== undefined ? (existing.title ?? null) : undefined,
				content: parsedContent !== undefined ? parsedContent : ifMatch !== undefined ? existing.content : undefined,
				tags: parsedTags !== undefined ? parsedTags : ifMatch !== undefined ? (existing.tags ?? []) : [],
				scopes: resolvedScopes,
				evidence:
					parsedEvidence !== undefined ? parsedEvidence : ifMatch !== undefined ? (existing.evidence ?? []) : [],
				validUntil:
					parsedValidUntil !== undefined
						? parsedValidUntil
						: ifMatch !== undefined
							? (existing.validUntil ?? null)
							: null,
			};

			const supersedesAllowed =
				payload.supersedes === undefined ||
				(ifMatch === undefined && sameStringArray(existing.supersedes ?? [], supersedes));
			if (sameEditableFields(existing, candidate) && supersedesAllowed) {
				if (ifMatch !== undefined && !matchesIfMatch(ifMatch, existing.revision)) {
					throw memoryError(
						`Stale write: If-Match ${ifMatch} does not match current revision ${existing.revision}`,
						412,
						'precondition_failed',
					);
				}
				return { id, revision: existing.revision, created: false, memory: toMemoryView(existing) };
			}

			if (payload.supersedes !== undefined) {
				throw badRequest('supersedes is only allowed when creating a memory', 'supersedes_not_allowed');
			}
			if (ifMatch === undefined) {
				throw memoryError('If-Match header is required to revise an existing memory', 428, 'if_match_required');
			}
			if (!matchesIfMatch(ifMatch, existing.revision)) {
				throw memoryError(
					`Stale write: If-Match ${ifMatch} does not match current revision ${existing.revision}`,
					412,
					'precondition_failed',
				);
			}
			// Frozen, so `replacement.scopes ⊇ superseded.scopes` keeps holding after the supersede, not only at it.
			if (existing.status === STATUS_SUPERSEDED) {
				throw memoryError('Memory has been superseded', 409, 'memory_superseded');
			}

			// The resulting scopes, not only changed ones: revising a memory that stays global keeps publishing
			// it globally.
			assertWritable(candidate.scopes, principal);
			if (scopesRequested) await assertStillCoversSuperseded(Memory, existing, candidate.scopes, txn);
			if (parsedEvidenceMemoryIds !== undefined) {
				await assertReadableEvidence(Memory, parsedEvidenceMemoryIds, principal, txn);
			}

			const nextRevision = existing.revision + 1;
			const changes: Record<string, any> = {
				...(parsedTitle !== undefined && { title: parsedTitle }),
				...(parsedContent !== undefined && { content: parsedContent, embeddingModel: settings.embeddingModel }),
				...(parsedTags !== undefined && { tags: parsedTags }),
				...(scopesRequested && { scopes: candidate.scopes }),
				...(parsedEvidence !== undefined && {
					evidence: parsedEvidence,
					evidenceMemoryIds: parsedEvidenceMemoryIds,
				}),
				...(parsedValidUntil !== undefined && { validUntil: parsedValidUntil }),
				revision: nextRevision,
				lastEditor: { principalId: principal.id, source: principal.source, revisedAt: new Date().toISOString() },
			};
			// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
			await Memory.patch(existing.id, changes, txn);
			const memory = toMemoryView(await Memory.get(existing.id, txn));
			if (hasSinks()) {
				await notifySinks('write', memory, txn);
			}
			return { id, revision: nextRevision, created: false, memory };
		}

		if (ifMatch !== undefined) {
			throw memoryError('Precondition failed: memory does not exist', 412, 'precondition_failed');
		}
		const title = boundedText(payload.title, 'title', settings.titleChars, true)!;
		const content = boundedText(payload.content, 'content', settings.contentChars, true)!;
		const scopes = normalizeScopes(payload.scopes, payload.visibility, principal.id);
		assertWritable(scopes, principal);
		const tags = parsedTags ?? [];
		const evidence = parsedEvidence ?? [];
		const evidenceMemoryIds = parsedEvidenceMemoryIds ?? [];
		const validUntil = parsedValidUntil ?? null;

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
				createdAt: now,
				author: { principalId: principal.id, source: principal.source, authoredAt: now.toISOString() },
				lastEditor: null,
				validUntil,
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
		return { id, revision: 1, created: true, memory };
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

/** The row is kept as a tombstone, never deleted, so a sink can retract its copy. */
export async function withdrawMemory(
	id: unknown,
	input: unknown = {},
	principal: Principal,
	requestContext: object = {},
) {
	const payload = rejectUnknownFields(input, WITHDRAW_FIELDS, 'withdraw');
	const reason = boundedText(payload.reason, 'reason', WITHDRAW_REASON_MAX_CHARS, false);
	if (!isMemoryId(id)) throw notFound();
	const ifMatch = getHeader(requestContext, 'if-match');
	const Memory = memoryTable();
	// A withdrawal also changes the memories it superseded. `supersedes` never changes after create, so a
	// pre-transaction read plans the lock set and lockRows is the first operation inside the transaction.
	const planned = await Memory.get(id, requestContext);

	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(Memory, [id, ...(planned?.supersedes ?? [])], txn);
		const existing = await Memory.get(id, txn);
		if (!existing) throw notFound();
		// A caller that cannot read the memory gets the same 404 as a missing one, so a write attempt does not
		// confirm another principal's memory exists. One that can read it gets an informative 403.
		if (existing.ownerId !== principal.id && !principal.superUser) {
			if (!canRead(existing, principal)) throw notFound();
			throw memoryError('Only the owner can modify this memory', 403, 'not_memory_owner');
		}
		if (ifMatch === undefined) {
			throw memoryError('If-Match header is required to withdraw a memory', 428, 'if_match_required');
		}
		if (existing.status === STATUS_WITHDRAWN) {
			throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
		}
		if (!matchesIfMatch(ifMatch, existing.revision)) {
			throw memoryError(
				`Stale write: If-Match ${ifMatch} does not match current revision ${existing.revision}`,
				412,
				'precondition_failed',
			);
		}

		// Withdrawal is exempt from assertWritable — locking an owner out of retracting would be worse.
		const changes = {
			status: STATUS_WITHDRAWN,
			withdrawnAt: new Date(),
			withdrawnReason: reason ?? null,
			revision: existing.revision + 1,
		};
		const restored = await reconcileSuperseded(Memory, existing, txn);
		// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
		await Memory.patch(existing.id, changes, txn);
		const memory = toMemoryView(await Memory.get(existing.id, txn));
		if (hasSinks()) {
			await notifySinks('withdraw', memory, txn);
			for (const targetId of restored) await notifySinks('write', toMemoryView(await Memory.get(targetId, txn)), txn);
		}
		return memory;
	});
}

export async function pinMemory(id: unknown, input: unknown = {}, principal: Principal, requestContext: object = {}) {
	rejectUnknownFields(input, [], 'pin');
	if (!isMemoryId(id)) throw notFound();
	const Memory = memoryTable();
	const MemoryPin = memoryPinTable();
	const pinId = memoryPinIdFor(principal.id, id);
	return inOwnTransaction(requestContext, async (txn) => {
		// Locking principal.id (which cannot contain ':') alongside pinId serializes concurrent pin checks
		// for this principal so two parallel pins of different memories cannot both pass the 50-pin cap.
		await lockRows(MemoryPin, [principal.id, pinId], txn);
		const record = await Memory.get(id, txn);
		// Same 404 whether missing or unreadable, so pinning cannot probe another principal's memory.
		if (!record || !canRead(record, principal)) throw notFound();
		const existing = await MemoryPin.get(pinId, txn);
		if (!existing) {
			const existingPins: Array<{ id: string; memoryId: string }> = [];
			for await (const pin of MemoryPin.search(
				{
					conditions: [{ attribute: 'principalId', comparator: 'equals', value: principal.id }],
					select: ['id', 'memoryId'],
				},
				txn,
			)) {
				existingPins.push(pin);
			}
			if (existingPins.length >= BOOTSTRAP_PINNED_LIMIT) {
				let retainedCount = 0;
				for (const pin of existingPins) {
					const target = await Memory.get(pin.memoryId, txn);
					// Only withdrawn (or missing) memories are terminal: supersession, expiry, and read access can all
					// revert later, so their pins stay retained and hidden by bootstrap until explicitly unpinned.
					if (!target || target.status === STATUS_WITHDRAWN) {
						await MemoryPin.delete(pin.id, txn);
					} else {
						retainedCount++;
					}
				}
				if (retainedCount >= BOOTSTRAP_PINNED_LIMIT) {
					throw memoryError(`Principal may pin at most ${BOOTSTRAP_PINNED_LIMIT} memories`, 409, 'pin_limit_exceeded');
				}
			}
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
		await lockRows(MemoryPin, [principal.id, pinId], txn);
		const record = await Memory.get(id, txn);
		if (!record || !canRead(record, principal)) throw notFound();
		await MemoryPin.delete(pinId, txn);
		return { pinned: false, memoryId: id, memory: toMemoryView(record) };
	});
}
