import { databases, models, transaction } from 'harper';
import { badRequest, isCallerSafe, memoryError, notFound, type MemoryError } from './errors.ts';
import { checkedText, matchCustomerContent } from './patterns.ts';
import { activeDependentIds, CLEARED_REVIEW, flagDependents, forReader, reviewFlagFor } from './provenance.ts';
import { CLEARED_CONTENT_FLAG, contentFlagFields, decideContentFlag, scheduleModelCheck } from './quarantine.ts';
import {
	assertWritable,
	canRead,
	GLOBAL_SCOPE,
	isCustomerScope,
	isSuperset,
	normalizeScopes,
	reviewsCustomerContent,
	type Principal,
} from './scopes.ts';
import { DEFAULT_EMBEDDING_MODEL, getSettings } from './settings.ts';
import { hasSinks, notifySinks } from './sinks.ts';
import { type Candidate, findCandidates, judgeCandidates, toCandidates } from './supersession.ts';

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
// An import writes up to 100 rows, and a transition flags every citer, inside one transaction; Harper's default
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

export function memoryWatchTable(): any {
	return (databases as any).memory.MemoryWatch;
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
		contentFlag: record.contentFlag
			? { ...record.contentFlag, ...(record.contentFlag.labels && { labels: [...record.contentFlag.labels] }) }
			: null,
		scopeConfirmed: record.scopeConfirmed ? { ...record.scopeConfirmed } : null,
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

// Every plugin write carries the vector it embedded before its transaction; a write that carries none is
// embedded here with the model recorded on the row, so the vector and the tag the vector lane filters on are
// always from the same write.
async function embedWithRecordModel(record: any, hook?: { signal?: AbortSignal }) {
	if (record.content == null) return null;
	if (Array.isArray(record.embedding) && record.embedding.length > 0) return record.embedding;
	const [vector] = await models.embed(String(record.content), {
		model: record.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
		inputType: 'document',
		signal: hook?.signal,
	});
	return vector ? Array.from(vector) : undefined;
}

export function ensureEmbedder(Memory: any): void {
	if (embedderInstalled.has(Memory)) return;
	Memory.setEmbedAttribute('embedding', embedWithRecordModel);
	embedderInstalled.add(Memory);
}

export async function embedContents(contents: string[], model: string): Promise<number[][]> {
	const vectors = await models.embed(contents, { model, inputType: 'document' });
	// The table's embedder would embed again, under the write's locks, for a missing or empty vector.
	if (vectors?.length !== contents.length || vectors.some((vector) => !vector?.length)) {
		throw new Error(`embedding model "${model}" returned no vector`);
	}
	return vectors.map((vector) => Array.from(vector));
}

async function embedContent(content: string, model: string): Promise<number[]> {
	return (await embedContents([content], model))[0];
}

/** The transaction is about to write content it holds no vector for; embedding it there would hold the locks. */
export class VectorNeeded {
	readonly ids: string[];
	constructor(ids: string[] = []) {
		this.ids = ids;
	}
}

/**
 * Serializes read-check-write against every other lifecycle operation on the same rows: Harper's record lock
 * excludes other lock() callers, and this plugin is the only writer of Memory. Sorted so operations that lock
 * several rows acquire them in one global order. Node scope, because a cluster-scoped lock on a replicated
 * database fails closed unless the cluster has opted into replicated record locks; across nodes, concurrent
 * revisions are therefore not serialized (replication keeps the later write).
 */
async function lockRows(Memory: any, ids: Iterable<string>, context: object, lease?: number): Promise<void> {
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

/**
 * Rule 4's content-review exception: a principal cleared to write customer content may move another principal's
 * flagged memory into customer labels, and change nothing else.
 */
function isReviewRescope(existing: any, payload: Record<string, any>, principal: Principal): boolean {
	return (
		Boolean(existing.contentFlag) &&
		reviewsCustomerContent(principal) &&
		Object.keys(payload).every((key) => key === 'scopes') &&
		Array.isArray(payload.scopes) &&
		payload.scopes.length > 0 &&
		payload.scopes.every((label: unknown) => typeof label === 'string' && isCustomerScope(label))
	);
}

function plannedScopes(
	payload: Record<string, any>,
	principal: Principal,
	ownerId: string,
	current?: string[],
): string[] | undefined {
	try {
		const scopes =
			current && payload.scopes == null && payload.visibility == null
				? current
				: normalizeScopes(payload.scopes, payload.visibility, ownerId);
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
	ensureEmbedder(Memory);
	const { supersession, customerContentCheck: check } = settings;
	// Matched while planning, outside the locks; the transaction matches again only if the row changed since.
	const matched = new Map<string, string[]>();
	const labelsFor = (text: string) => {
		let labels = matched.get(text);
		if (!labels) matched.set(text, (labels = matchCustomerContent(text, check.matcher)));
		return labels;
	};

	// Planning runs again when the transaction finds the pre-read overtaken; `reembed` then guarantees a vector.
	const newCitations = (record: any): string[] =>
		(parsedEvidenceMemoryIds ?? []).filter((refId) => !(record?.evidenceMemoryIds ?? []).includes(refId));
	const plan = async (reembed: boolean) => {
		// Planning runs only for what looks like a permitted write, so a refused or no-op PUT never pays for an
		// embedding, a judge call or a citer fan-out. The transaction re-checks everything under its locks.
		const preExisting = await Memory.get(id, requestContext);
		const cited = await Promise.all((parsedEvidenceMemoryIds ?? []).map((refId) => Memory.get(refId, requestContext)));
		const citedReadable = cited.every((record) => record && canRead(record, principal));
		const createScopes =
			!preExisting && ifMatch === undefined && parsedTitle !== undefined && parsedContent !== undefined && citedReadable
				? plannedScopes(payload, principal, principal.id)
				: undefined;
		const refused = (target: any) => supersedeRefusal(target, createScopes!, principal) !== undefined;
		const explicitTargets = createScopes
			? await Promise.all(supersedes.map((targetId) => Memory.get(targetId, requestContext)))
			: [];
		const planningCreate = createScopes !== undefined && !explicitTargets.some(refused);
		const revisedScopes =
			preExisting &&
			ifMatch !== undefined &&
			matchesIfMatch(ifMatch, preExisting.revision) &&
			(ifNoneMatch === undefined || !matchesIfNoneMatch(ifNoneMatch, preExisting.revision)) &&
			payload.supersedes === undefined &&
			(preExisting.ownerId === principal.id || principal.superUser) &&
			preExisting.status === STATUS_ACTIVE &&
			citedReadable
				? plannedScopes(payload, principal, preExisting.ownerId, preExisting.scopes)
				: undefined;
		const mayRevise = revisedScopes !== undefined;
		if (check.mode === 'flag' && (planningCreate ? createScopes : revisedScopes)?.includes(GLOBAL_SCOPE)) {
			labelsFor(
				checkedText({
					title: parsedTitle ?? (planningCreate ? null : preExisting.title),
					content: parsedContent ?? (planningCreate ? null : preExisting.content),
					tags: parsedTags ?? (planningCreate ? [] : preExisting.tags),
					evidence: parsedEvidence ?? (planningCreate ? [] : preExisting.evidence),
				}),
			);
		}
		const writesContent =
			parsedContent !== undefined &&
			(planningCreate ||
				(mayRevise &&
					(parsedContent !== preExisting.content || preExisting.embeddingModel !== settings.embeddingModel)));
		const vector = writesContent || reembed ? await embedContent(parsedContent!, settings.embeddingModel) : undefined;
		// supersedes never changes after create, so auto verdicts must exist before the create commits.
		const proposals =
			planningCreate && supersession.mode === 'auto'
				? await judgeCandidates(
						{ title: parsedTitle!, content: parsedContent! },
						await findCandidates(
							{
								vector,
								embeddingModel: settings.embeddingModel,
								scopes: createScopes!,
								excludeIds: [id, ...supersedes],
							},
							principal,
							supersession.similarity,
							requestContext,
						),
						supersession.judge,
					)
				: undefined;
		const autoTargets = (proposals ?? []).filter(
			(match) => match.verdict === 'supersedes' && !supersedes.includes(match.id),
		);
		let plannedDependents: string[] = [];
		if (planningCreate && supersedes.length + autoTargets.length > 0) {
			const transitioning = [...explicitTargets, ...autoTargets].filter(
				(target) => target?.status === STATUS_ACTIVE && !refused(target),
			);
			plannedDependents = await activeDependentIds(
				Memory,
				transitioning.map((target) => target.id),
				requestContext,
			);
		}
		const citedLocks = planningCreate || mayRevise ? newCitations(preExisting) : [];
		return { planningCreate, vector, proposals, autoTargets, plannedDependents, citedLocks };
	};

	const write = (planned: Awaited<ReturnType<typeof plan>>) =>
		withLockPlan(
			requestContext,
			[
				id,
				...(planned.planningCreate ? supersedes : []),
				...planned.autoTargets.map((match) => match.id),
				// A new citation serializes with the cited memory's supersede or withdrawal, so a citer is either flagged
				// by it or reads the source's new status. A citation the row already has is in the index, where a
				// transition finds the citer and locks it. A write the cheap checks refuse locks none of them.
				...planned.citedLocks,
				...planned.plannedDependents,
			],
			async (txn, locks) => {
				const existing = await Memory.get(id, txn);
				const now = new Date();
				if (existing) {
					if (existing.ownerId !== principal.id && !principal.superUser) {
						if (!canRead(existing, principal)) {
							throw memoryError('Memory id is not available', 409, 'id_unavailable');
						}
						if (!isReviewRescope(existing, payload, principal)) {
							throw memoryError('Only the owner can modify this memory', 403, 'not_memory_owner');
						}
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
						title:
							parsedTitle !== undefined ? parsedTitle : ifMatch !== undefined ? (existing.title ?? null) : undefined,
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
						return { created: false, textChanged: false, modelCheck: false, written: captureWritten(existing) };
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
					const contentChanged =
						parsedContent !== undefined &&
						(parsedContent !== existing.content || existing.embeddingModel !== settings.embeddingModel);
					if (contentChanged && planned.vector === undefined) throw new VectorNeeded();
					locks.require(newCitations(existing));
					const decision = decideContentFlag(
						check,
						{ scopes: existing.scopes ?? [], text: checkedText(existing), flag: existing.contentFlag ?? null },
						candidate.scopes,
						checkedText(candidate),
						labelsFor,
						now,
					);
					const changes: Record<string, any> = {
						...(parsedTitle !== undefined && { title: parsedTitle }),
						...(contentChanged && {
							content: parsedContent,
							embedding: planned.vector,
							embeddingModel: settings.embeddingModel,
						}),
						...(parsedTags !== undefined && { tags: parsedTags }),
						...(scopesRequested && { scopes: candidate.scopes }),
						...(parsedEvidence !== undefined && {
							evidence: parsedEvidence,
							evidenceMemoryIds: parsedEvidenceMemoryIds,
						}),
						...(parsedValidUntil !== undefined && { validUntil: parsedValidUntil }),
						// A revision is the owner's review: it clears a flag without re-flagging this memory's own citers.
						...(existing.needsReview && CLEARED_REVIEW),
						...contentFlagFields(decision.flag),
						lastEventKind: 'revised',
						revision: existing.revision + 1,
						lastEditor: { principalId: principal.id, source: principal.source, revisedAt: now.toISOString() },
					};
					// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
					await Memory.patch(existing.id, changes, txn);
					const revised = await Memory.get(existing.id, txn);
					if (hasSinks()) {
						await notifySinks('write', toMemoryView(revised), txn);
					}
					const textChanged = contentChanged || (parsedTitle !== undefined && parsedTitle !== existing.title);
					return { created: false, textChanged, modelCheck: decision.modelCheck, written: captureWritten(revised) };
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
				// Refusals are decided before anything joins the lock set, so a refused create locks nothing it names;
				// rows read here are re-read under their locks on the attempt the require below restarts into.
				const targets = [];
				for (const targetId of supersedes) {
					const target = await Memory.get(targetId, txn);
					const refusal = supersedeRefusal(target, scopes, principal);
					if (refusal) throw refusal;
					targets.push(target);
				}
				const applied: string[] = [];
				for (const proposal of planned.autoTargets) {
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
				// Superseding an already superseded memory is not a transition: its citers were flagged the first time.
				const transitions = pointers.filter(({ target }) => target.status === STATUS_ACTIVE);
				const citers = new Map<string, string[]>();
				for (const { target } of transitions) {
					citers.set(target.id, await activeDependentIds(Memory, [target.id], txn));
				}
				if (planned.vector === undefined) throw new VectorNeeded();
				locks.require([...evidenceMemoryIds, ...supersedes, ...[...citers.values()].flat()]);
				const decision = decideContentFlag(
					check,
					undefined,
					scopes,
					checkedText({ title, content, tags, evidence }),
					labelsFor,
					now,
				);

				await Memory.put(
					{
						id,
						title,
						content,
						embedding: planned.vector,
						tags,
						scopes,
						ownerId: principal.id,
						status: STATUS_ACTIVE,
						revision: 1,
						lastEventKind: 'created',
						evidence,
						evidenceMemoryIds,
						supersedes: [...supersedes, ...applied],
						autoSupersedes: applied,
						supersededBy: null,
						...CLEARED_REVIEW,
						confirmed: null,
						...contentFlagFields(decision.flag),
						scopeConfirmed: null,
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
					await Memory.patch(
						target.id,
						{ status: STATUS_SUPERSEDED, supersededBy, lastEventKind: 'superseded', revision: target.revision + 1 },
						txn,
					);
				}
				const flagged: string[] = [];
				for (const { target, supersededBy } of transitions) {
					flagged.push(
						...(await flagDependents(
							Memory,
							{ id: target.id, replacementId: supersededBy },
							'superseded',
							citers.get(target.id)!,
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
				return {
					created: true,
					textChanged: true,
					modelCheck: decision.modelCheck,
					written: captureWritten(created),
					applied,
				};
			},
			supersedes.length + planned.autoTargets.length > 0 ? LONG_LOCK_LEASE_MS : undefined,
		);
	let planned = await plan(false);
	let outcome;
	try {
		outcome = await write(planned);
	} catch (error) {
		// Another writer changed the row after the pre-read: plan again, embedding outside the locks, and retry.
		if (!(error instanceof VectorNeeded)) throw error;
		planned = await plan(true);
		outcome = await write(planned);
	}
	const { proposals } = planned;

	const { memory } = outcome.written;
	if (outcome.modelCheck) scheduleModelCheck(id, memory, requestContext);
	const [view] = await forReader([memory], principal, requestContext);
	if (supersession.mode === 'off') {
		return { id, revision: memory.revision as number, created: outcome.created, memory: view, candidates: [] };
	}
	// A concurrent identical create can win the id after this request judged; its proposals then describe nothing.
	const decided = 'applied' in outcome ? proposals : undefined;
	const matches =
		decided ??
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
			outcome.textChanged ? supersession.judge : undefined,
		));
	const candidates: Candidate[] = toCandidates(
		matches,
		decided && 'applied' in outcome ? new Set(outcome.applied) : undefined,
	);
	return { id, revision: memory.revision as number, created: outcome.created, memory: view, candidates };
}

function captureWritten(record: any) {
	return {
		memory: toMemoryView(record),
		vector: record.embedding ? Array.from(record.embedding as ArrayLike<number>) : undefined,
		embeddingModel: (record.embeddingModel ?? DEFAULT_EMBEDDING_MODEL) as string,
	};
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
async function reconcileSuperseded(Memory: any, withdrawn: any, context: object, now: Date): Promise<string[]> {
	const changed: string[] = [];
	for (const targetId of withdrawn.supersedes ?? []) {
		const target = await Memory.get(targetId, context);
		if (target?.status !== STATUS_SUPERSEDED) continue;
		const newest = await newestSuperseder(Memory, targetId, context, withdrawn.id);
		const next = newest
			? { status: STATUS_SUPERSEDED, supersededBy: newest.id, lastEventKind: 'superseded' }
			: { status: STATUS_ACTIVE, supersededBy: null, lastEventKind: 'restored' };
		if (next.status === target.status && next.supersededBy === target.supersededBy) continue;
		// A memory restored to active that also cited the withdrawn memory gets its review flag in the same patch
		// so its single transition event remains `restored`.
		const flagPatch =
			next.status === STATUS_ACTIVE
				? reviewFlagFor(
						{ ...target, status: STATUS_ACTIVE },
						{ id: withdrawn.id, replacementId: withdrawn.supersededBy ?? undefined },
						'withdrawn',
						now,
					)
				: undefined;
		await Memory.patch(targetId, { ...next, ...flagPatch, revision: target.revision + 1 }, context);
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
		planned &&
		ifMatch !== undefined &&
		matchesIfMatch(ifMatch, planned.revision) &&
		planned.status !== STATUS_WITHDRAWN &&
		(planned.ownerId === principal.id || principal.superUser);
	const plan = mayWithdraw
		? [id, ...(planned.supersedes ?? []), ...(await activeDependentIds(Memory, [id], requestContext))]
		: [id];

	return withLockPlan(
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
			const citers = await activeDependentIds(Memory, [id], txn);
			locks.require([...(existing.supersedes ?? []), ...citers]);

			const now = new Date();
			const restored = await reconcileSuperseded(Memory, existing, txn, now);
			// Withdrawal is exempt from assertWritable — locking an owner out of retracting would be worse.
			// patch, not put: a put would echo @updatedTime back as a caller-supplied value.
			await Memory.patch(
				existing.id,
				{
					status: STATUS_WITHDRAWN,
					withdrawnAt: now,
					withdrawnReason: reason ?? null,
					lastEventKind: 'withdrawn',
					revision: existing.revision + 1,
				},
				txn,
			);
			const restoredSet = new Set(restored);
			const flagged = await flagDependents(
				Memory,
				{ id: existing.id, replacementId: existing.supersededBy ?? undefined },
				'withdrawn',
				citers.filter((citerId) => !restoredSet.has(citerId)),
				txn,
				now,
			);
			const memory = toMemoryView(await Memory.get(existing.id, txn));
			if (hasSinks()) {
				await notifySinks('withdraw', memory, txn);
				for (const changedId of new Set([...restored, ...flagged])) {
					await notifySinks('write', toMemoryView(await Memory.get(changedId, txn)), txn);
				}
			}
			return (await forReader([memory], principal, txn))[0];
		},
		LONG_LOCK_LEASE_MS,
	);
}

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
	return withLockPlan(requestContext, [id], async (txn) => {
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
				lastEventKind: 'revised',
				revision: existing.revision + 1,
			},
			txn,
		);
		const memory = toMemoryView(await Memory.get(id, txn));
		if (hasSinks()) await notifySinks('write', memory, txn);
		return (await forReader([memory], principal, txn))[0];
	});
}

/**
 * A customer reviewer's ruling that a flagged memory may stay `global`. It holds for the text it reviewed: a revise
 * that changes the checked text runs the check again.
 */
export async function confirmScopeMemory(
	id: unknown,
	input: unknown = {},
	principal: Principal,
	requestContext: object = {},
) {
	rejectUnknownFields(input, [], 'confirm-scope');
	if (!isMemoryId(id)) throw notFound();
	const ifMatch = getHeader(requestContext, 'if-match');
	const Memory = memoryTable();
	return withLockPlan(requestContext, [id], async (txn) => {
		const existing = await Memory.get(id, txn);
		if (!existing || !canRead(existing, principal)) throw notFound();
		// Not the owner alone: an owner without customer clearance would publish what the flag withheld.
		if (!reviewsCustomerContent(principal)) {
			throw memoryError('Confirming a flagged memory requires customer:* write', 403, 'customer_clearance_required');
		}
		if (existing.status === STATUS_WITHDRAWN) throw memoryError('Memory has been withdrawn', 409, 'memory_withdrawn');
		if (ifMatch !== undefined && !matchesIfMatch(ifMatch, existing.revision)) {
			throw staleWrite(ifMatch, existing.revision);
		}
		if (!existing.contentFlag) throw memoryError('Memory is not flagged', 409, 'not_flagged');
		await Memory.patch(
			id,
			{
				...CLEARED_CONTENT_FLAG,
				scopeConfirmed: { by: principal.id, at: new Date().toISOString() },
				lastEventKind: 'revised',
				revision: existing.revision + 1,
			},
			txn,
		);
		const memory = toMemoryView(await Memory.get(id, txn));
		if (hasSinks()) await notifySinks('write', memory, txn);
		return (await forReader([memory], principal, txn))[0];
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
