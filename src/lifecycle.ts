import { databases, models, transaction } from 'harper';
import { badRequest, isCallerSafe, memoryError, notFound, type MemoryError } from './errors.ts';
import { activeDependentIds, CLEARED_REVIEW, flagDependents, forReader } from './provenance.ts';
import { assertWritable, canRead, isSuperset, normalizeScopes, type Principal } from './scopes.ts';
import { DEFAULT_EMBEDDING_MODEL, getSettings, type Settings } from './settings.ts';
import { hasSinks, notifySinks } from './sinks.ts';
import {
	type Candidate,
	type CandidateMatch,
	findCandidates,
	judgeCandidates,
	toCandidates,
	warnRateLimited,
} from './supersession.ts';

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
// An import embeds every row, and a transition flags every dependent, inside one transaction; Harper's default
// 30 s lease could lapse before commit.
export const LONG_LOCK_LEASE_MS = 5 * 60_000;
const LOCK_PLAN_ATTEMPTS = 3;

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
		autoSupersedes: [...(record.autoSupersedes ?? [])],
		supersededBy: record.supersededBy ?? null,
		needsReview: record.needsReview ? { ...record.needsReview } : null,
		confirmed: record.confirmed ? { ...record.confirmed } : null,
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

export interface LockPlan {
	/** Aborts the attempt unless every id is already locked; the next attempt locks them up front. */
	require(ids: Iterable<string>): void;
}

class LockPlanStale {
	readonly ids: string[];
	constructor(ids: string[]) {
		this.ids = ids;
	}
}

/**
 * Runs `operation` in its own transaction after locking every planned Memory row. Rows the operation discovers
 * it must change (a dependent, a `supersedes` populated after planning) go through `locks.require` before they
 * are read or written; an unplanned one aborts the attempt and the next locks the union in one sorted pass, so
 * no operation ever waits for a lock while holding one out of order.
 */
export async function withLockPlan<T>(
	requestContext: object,
	planned: Iterable<string>,
	operation: (context: object, locks: LockPlan) => Promise<T>,
	lease?: number,
): Promise<T> {
	const Memory = memoryTable();
	const plan = new Set(planned);
	for (let attempt = 1; ; attempt++) {
		try {
			return await inOwnTransaction(requestContext, async (txn) => {
				await lockRows(Memory, plan, txn, lease);
				return operation(txn, {
					require(ids) {
						const missing = [...ids].filter((id) => !plan.has(id));
						if (missing.length > 0) throw new LockPlanStale(missing);
					},
				});
			});
		} catch (error) {
			if (!(error instanceof LockPlanStale)) throw error;
			if (attempt === LOCK_PLAN_ATTEMPTS) {
				throw memoryError('Memories this operation changes kept changing; retry shortly', 503, 'unavailable');
			}
			for (const id of error.ids) plan.add(id);
		}
	}
}

export async function getMemory(id: string, principal: Principal, context?: object) {
	const record = isMemoryId(id) ? await memoryTable().get(id, context) : undefined;
	if (!record || !canRead(record, principal)) return undefined;
	return (await forReader([toMemoryView(record)], principal, context))[0];
}

function staleWrite(ifMatch: string, revision: number): MemoryError {
	return memoryError(
		`Stale write: If-Match ${ifMatch} does not match current revision ${revision}`,
		412,
		'precondition_failed',
	);
}

/** The explicit-supersede rules. Returned rather than thrown so an auto candidate that fails one is only reported. */
function supersedeRefusal(target: any, scopes: readonly string[], principal: Principal): MemoryError | undefined {
	// Same 404 as a missing id, so supersedes is not a probe for another principal's memory.
	if (!target || !canRead(target, principal)) return notFound();
	if (target.status === STATUS_WITHDRAWN) return memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
	if (!isSuperset(scopes, target.scopes ?? [])) {
		return memoryError(
			'A superseding memory must carry every scope label of the memory it supersedes',
			403,
			'supersede_scope_narrowing',
		);
	}
	return undefined;
}

/** The scopes a create would write, or undefined when the transaction is going to refuse it anyway. */
function plannedCreateScopes(payload: Record<string, any>, principal: Principal): string[] | undefined {
	try {
		const scopes = normalizeScopes(payload.scopes, payload.visibility, principal.id);
		assertWritable(scopes, principal);
		return scopes;
	} catch (error) {
		if (isCallerSafe(error)) return undefined;
		throw error;
	}
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
	const { supersession } = settings;

	// Planning reads run only for what looks like a permitted create, so a refused or no-op PUT never pays for an
	// embedding, a judge call or a dependent fan-out. The transaction re-checks everything under its locks.
	const createScopes =
		ifMatch === undefined &&
		parsedTitle !== undefined &&
		parsedContent !== undefined &&
		(supersession.mode === 'auto' || supersedes.length > 0)
			? plannedCreateScopes(payload, principal)
			: undefined;
	const planningCreate = createScopes !== undefined && !(await Memory.get(id, requestContext));
	// supersedes never changes after create, so auto verdicts must exist before the create commits.
	const proposals =
		planningCreate && supersession.mode === 'auto'
			? await proposeSupersedes(
					id,
					parsedTitle!,
					parsedContent!,
					createScopes!,
					supersedes,
					principal,
					settings,
					requestContext,
				)
			: undefined;
	const autoTargets = (proposals ?? []).filter(
		(match) => match.verdict === 'supersedes' && !supersedes.includes(match.id),
	);
	let plannedDependents: string[] = [];
	if (planningCreate && supersedes.length + autoTargets.length > 0) {
		const preTargets = await Promise.all(
			[...supersedes, ...autoTargets.map((match) => match.id)].map((targetId) => Memory.get(targetId, requestContext)),
		);
		const refused = (target: any) => supersedeRefusal(target, createScopes!, principal) !== undefined;
		if (!preTargets.slice(0, supersedes.length).some(refused)) {
			const transitioning = preTargets.filter((target) => target?.status === STATUS_ACTIVE && !refused(target));
			plannedDependents = await activeDependentIds(
				Memory,
				transitioning.map((target) => target.id),
				requestContext,
			);
		}
	}

	const outcome = await withLockPlan(
		requestContext,
		[
			id,
			...supersedes,
			...autoTargets.map((match) => match.id),
			// Citing serializes with the cited memory's supersede or withdrawal, so a citer is either flagged by it
			// or reads the source's new status.
			...(parsedEvidenceMemoryIds ?? []),
			...plannedDependents,
		],
		async (txn, locks) => {
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

				// The links the author sent: an identical retry of an auto-mode create carries only those.
				const authoredSupersedes = (existing.supersedes ?? []).filter(
					(targetId: string) => !(existing.autoSupersedes ?? []).includes(targetId),
				);
				const supersedesAllowed =
					payload.supersedes === undefined ||
					(ifMatch === undefined && sameStringArray(authoredSupersedes, supersedes));
				if (sameEditableFields(existing, candidate) && supersedesAllowed) {
					if (ifMatch !== undefined && !matchesIfMatch(ifMatch, existing.revision)) {
						throw staleWrite(ifMatch, existing.revision);
					}
					return { created: false, written: captureWritten(existing) };
				}

				if (payload.supersedes !== undefined) {
					throw badRequest('supersedes is only allowed when creating a memory', 'supersedes_not_allowed');
				}
				if (ifMatch === undefined) {
					throw memoryError('If-Match header is required to revise an existing memory', 428, 'if_match_required');
				}
				if (!matchesIfMatch(ifMatch, existing.revision)) throw staleWrite(ifMatch, existing.revision);
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
					// A revision is the owner's review: it clears a flag without re-flagging this memory's own citers.
					...(existing.needsReview && CLEARED_REVIEW),
					revision: existing.revision + 1,
					lastEditor: { principalId: principal.id, source: principal.source, revisedAt: new Date().toISOString() },
				};
				// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
				await Memory.patch(existing.id, changes, txn);
				const revised = await Memory.get(existing.id, txn);
				if (hasSinks()) {
					await notifySinks('write', toMemoryView(revised), txn);
				}
				return { created: false, written: captureWritten(revised) };
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
				const refusal = supersedeRefusal(target, scopes, principal);
				if (refusal) throw refusal;
				targets.push(target);
			}
			const applied: string[] = [];
			for (const proposal of autoTargets) {
				const target = await Memory.get(proposal.id, txn);
				// The judge compared this revision; a later one is content it never saw.
				if (target?.revision !== proposal.revision || supersedeRefusal(target, scopes, principal)) continue;
				targets.push(target);
				applied.push(target.id);
			}
			const pointers = [];
			for (const target of targets) {
				// The newest superseder wins the pointer, which is not necessarily this one: an imported superseder can
				// carry a later createdAt, and two creates can share a millisecond.
				const current = await newestSuperseder(Memory, target.id, txn);
				const supersededBy = current && compareNewest(current, { id, createdAt: now }) > 0 ? current.id : id;
				pointers.push({ target, supersededBy });
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
					supersedes: [...supersedes, ...applied],
					autoSupersedes: applied,
					supersededBy: null,
					...CLEARED_REVIEW,
					confirmed: null,
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
			for (const { target, supersededBy } of pointers) {
				await Memory.patch(target.id, { status: STATUS_SUPERSEDED, supersededBy, revision: target.revision + 1 }, txn);
			}
			const flagged: string[] = [];
			for (const { target, supersededBy } of pointers) {
				// Superseding an already superseded memory is not a transition: its citers were flagged the first time.
				if (target.status !== STATUS_ACTIVE) continue;
				flagged.push(
					...(await flagDependents(
						Memory,
						{ id: target.id, replacementId: supersededBy },
						'superseded',
						locks,
						txn,
						now,
					)),
				);
			}
			// Re-read inside the transaction: @updatedTime is applied by the database.
			const created = await Memory.get(id, txn);
			if (hasSinks()) {
				await notifySinks('write', toMemoryView(created), txn);
				for (const changedId of [...pointers.map(({ target }) => target.id), ...flagged]) {
					await notifySinks('write', toMemoryView(await Memory.get(changedId, txn)), txn);
				}
			}
			return { created: true, written: captureWritten(created), applied };
		},
		supersedes.length + autoTargets.length > 0 ? LONG_LOCK_LEASE_MS : undefined,
	);

	const { memory } = outcome.written;
	const matches =
		proposals ??
		(await judgeCandidates(
			memory,
			await findCandidates(
				{
					vector: outcome.written.vector,
					embeddingModel: outcome.written.embeddingModel,
					scopes: memory.scopes as string[],
					excludeIds: [id, ...(memory.supersedes as string[])],
				},
				principal,
				supersession.similarity,
				requestContext,
			),
			supersession.judge,
		));
	const candidates: Candidate[] = toCandidates(
		matches,
		proposals ? new Set('applied' in outcome ? outcome.applied : []) : undefined,
	);
	return { id, revision: memory.revision as number, created: outcome.created, memory, candidates };
}

/** Read inside the transaction, kept for the post-commit candidate search. */
function captureWritten(record: any) {
	return {
		memory: toMemoryView(record),
		vector: record.embedding ? Array.from(record.embedding as ArrayLike<number>) : undefined,
		embeddingModel: (record.embeddingModel ?? DEFAULT_EMBEDDING_MODEL) as string,
	};
}

/**
 * Embeds the new content itself: the table's own embedding happens inside the create, after the verdicts are
 * needed. Undefined when it cannot embed, which leaves the write to advisory candidates rather than failing it.
 */
async function proposeSupersedes(
	id: string,
	title: string,
	content: string,
	scopes: string[],
	supersedes: readonly string[],
	principal: Principal,
	settings: Settings,
	context: object,
): Promise<CandidateMatch[] | undefined> {
	let vector: ArrayLike<number> | undefined;
	try {
		[vector] = await models.embed(content, { model: settings.embeddingModel, inputType: 'document' });
	} catch (error) {
		warnRateLimited('auto-embed', 'supersession auto mode could not embed a create; judging after commit', error);
		return undefined;
	}
	const matches = await findCandidates(
		{ vector, embeddingModel: settings.embeddingModel, scopes, excludeIds: [id, ...supersedes] },
		principal,
		settings.supersession.similarity,
		context,
	);
	return judgeCandidates({ title, content }, matches, settings.supersession.judge);
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
	// A withdrawal also changes the memories it superseded (`supersedes` never changes after create) and flags the
	// memories citing it, so a pre-transaction read plans the lock set. Only a withdrawal the caller may make reaches
	// the dependent fan-out, so a refused request never locks the citation graph.
	const planned = await Memory.get(id, requestContext);
	const mayWithdraw =
		planned !== undefined &&
		ifMatch !== undefined &&
		planned.status !== STATUS_WITHDRAWN &&
		(planned.ownerId === principal.id || principal.superUser);
	const plan = [
		id,
		...(planned?.supersedes ?? []),
		...(mayWithdraw ? await activeDependentIds(Memory, [id], requestContext) : []),
	];

	const memory = await withLockPlan(
		requestContext,
		plan,
		async (txn, locks) => {
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
			if (!matchesIfMatch(ifMatch, existing.revision)) throw staleWrite(ifMatch, existing.revision);
			locks.require(existing.supersedes ?? []);

			const now = new Date();
			const restored = await reconcileSuperseded(Memory, existing, txn);
			// Withdrawal is exempt from assertWritable — locking an owner out of retracting would be worse.
			// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
			await Memory.patch(
				existing.id,
				{
					status: STATUS_WITHDRAWN,
					withdrawnAt: now,
					withdrawnReason: reason ?? null,
					revision: existing.revision + 1,
				},
				txn,
			);
			const flagged = await flagDependents(Memory, { id: existing.id }, 'withdrawn', locks, txn, now);
			const memory = toMemoryView(await Memory.get(existing.id, txn));
			if (hasSinks()) {
				await notifySinks('withdraw', memory, txn);
				for (const changedId of [...restored, ...flagged]) {
					await notifySinks('write', toMemoryView(await Memory.get(changedId, txn)), txn);
				}
			}
			return memory;
		},
		LONG_LOCK_LEASE_MS,
	);
	return (await forReader([memory], principal, requestContext))[0];
}

/**
 * The owner's record that they reviewed the memory as it stands: clears `needsReview` and records `{ by, at }`.
 * Like a revision, it never flags this memory's own citers.
 */
export async function confirmMemory(
	id: unknown,
	input: unknown = {},
	principal: Principal,
	requestContext: object = {},
) {
	rejectUnknownFields(input, [], 'confirm');
	if (!isMemoryId(id)) throw notFound();
	const ifMatch = getHeader(requestContext, 'if-match');
	const Memory = memoryTable();
	const memory = await withLockPlan(requestContext, [id], async (txn) => {
		const existing = await Memory.get(id, txn);
		if (!existing) throw notFound();
		if (existing.ownerId !== principal.id && !principal.superUser) {
			if (!canRead(existing, principal)) throw notFound();
			throw memoryError('Only the owner can modify this memory', 403, 'not_memory_owner');
		}
		if (existing.status === STATUS_WITHDRAWN) throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
		if (existing.status === STATUS_SUPERSEDED) {
			throw memoryError('Memory has been superseded', 409, 'memory_superseded');
		}
		if (ifMatch !== undefined && !matchesIfMatch(ifMatch, existing.revision)) {
			throw staleWrite(ifMatch, existing.revision);
		}
		await Memory.patch(
			id,
			{
				...CLEARED_REVIEW,
				confirmed: { by: principal.id, at: new Date().toISOString() },
				revision: existing.revision + 1,
			},
			txn,
		);
		const memory = toMemoryView(await Memory.get(id, txn));
		if (hasSinks()) await notifySinks('write', memory, txn);
		return memory;
	});
	return (await forReader([memory], principal, requestContext))[0];
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
		return { pinned: true, memoryId: id, memory: (await forReader([toMemoryView(record)], principal, txn))[0] };
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
		await MemoryPin.delete(pinId, txn);
		const record = await Memory.get(id, txn);
		// Missing and unreadable both omit `memory`, so unpinning a descoped pin works without probing existence.
		if (!record || !canRead(record, principal)) return { pinned: false, memoryId: id };
		return { pinned: false, memoryId: id, memory: (await forReader([toMemoryView(record)], principal, txn))[0] };
	});
}
