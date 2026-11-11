import { logger } from 'harper';
import { badRequest, memoryError } from './errors.ts';
import { recordWatches, WATCH_DEFAULT_TTL_SECONDS } from './events.ts';
import { registeredBootstrapSections, renderBootstrapSections } from './extensions.ts';
import {
	BOOTSTRAP_PINNED_LIMIT,
	embedTexts,
	isMemoryId,
	memoryPinTable,
	memoryTable,
	STATUS_ACTIVE,
	STATUS_SUPERSEDED,
	STATUS_WITHDRAWN,
	toMemoryView,
	type MemoryView,
} from './lifecycle.ts';
import { forReader } from './provenance.ts';
import { anyOf, canRead, isScopeLabel, readableConditions, type Condition, type Principal } from './scopes.ts';
import { getSettings } from './settings.ts';

const RRF_K = 60;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_DEFAULT_LIMIT = 10;
const QUERY_MAX_CHARS = 1000;
// Both derived indexes apply commits after the fact. See "Searchable at commit" in DESIGN.md for when a
// search waits for their coverage.
export const INDEX_WAIT_MS = 5000;
// The window must exceed the lag by the longest a write transaction may stay open: `updatedAt` is stamped at its
// first lock or read, not at commit.
export const INDEX_LAG_MS = 3000;
export const RECENT_WRITE_WINDOW_MS = 10_000;
export const RECENT_WRITE_SCAN = 100;
const INDEX_LAGGING = 'DERIVED_INDEX_LAGGING';
const BOOTSTRAP_DEFAULT_BUDGET = 8000;
const BOOTSTRAP_MAX_BUDGET = 100_000;
const BOOTSTRAP_RECENT_LIMIT = 50;
const BOOTSTRAP_RELEVANT_LIMIT = 20;
const BOOTSTRAP_REVIEW_LIMIT = 20;
// Bounds the rows a bootstrap inspects when most of a caller's flags name sources it can no longer read.
const BOOTSTRAP_REVIEW_SCAN = 5 * BOOTSTRAP_REVIEW_LIMIT;

export const VIEW_FIELDS = [
	'id',
	'title',
	'content',
	'tags',
	'scopes',
	'ownerId',
	'status',
	'revision',
	'evidence',
	'evidenceMemoryIds',
	'supersedes',
	'autoSupersedes',
	'supersededBy',
	'needsReview',
	'confirmed',
	'contentFlag',
	'scopeConfirmed',
	'author',
	'lastEditor',
	'validUntil',
	'withdrawnAt',
	'withdrawnReason',
	'createdAt',
	'updatedAt',
];

export interface SearchParams {
	q?: string;
	tags: string[];
	scopes: string[];
	limit: number;
	includeSuperseded: boolean;
	includeExpired: boolean;
	includeWithdrawn?: boolean;
	flagged?: boolean;
	watch?: boolean;
	order?: 'created';
	after?: CreatedPosition;
}

export interface CreatedPosition {
	createdAt: Date;
	id: string;
}

// `<createdAt ISO>,<id>`: neither part can contain a comma.
function parseCursor(value: string | null): CreatedPosition | undefined {
	if (value === null || value === '') return undefined;
	const [at, id, ...rest] = value.split(',');
	const createdAt = new Date(at);
	if (rest.length > 0 || !isMemoryId(id) || !at || Number.isNaN(createdAt.getTime())) {
		throw badRequest('after must be "<createdAt>,<id>" from the last memory of the previous page', 'invalid_after');
	}
	return { createdAt, id };
}

function boundedInteger(value: string | null, field: string, fallback: number, max: number): number {
	if (value === null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw badRequest(`${field} must be an integer between 1 and ${max}`, `invalid_${field}`);
	}
	return parsed;
}

function optionalQuery(value: string | null): string | undefined {
	const q = value?.trim();
	if (!q) return undefined;
	if (q.length > QUERY_MAX_CHARS) throw badRequest(`q exceeds ${QUERY_MAX_CHARS} characters`, 'q_too_long');
	return q;
}

function booleanParam(params: URLSearchParams, name: string): boolean {
	const value = params.get(name);
	if (value !== null && value !== 'true' && value !== 'false') {
		throw badRequest(`${name} must be true or false`, `invalid_${name}`);
	}
	return value === 'true';
}

export function parseSearchParams(params: URLSearchParams): SearchParams {
	const scopes = params.getAll('scope');
	if (!scopes.every(isScopeLabel)) throw badRequest('scope must be a scope label', 'invalid_scope_label');
	const q = optionalQuery(params.get('q'));
	const order = params.get('order');
	if (order !== null && (order !== 'created' || q)) {
		throw badRequest('order must be created, and applies only without q', 'invalid_order');
	}
	const after = parseCursor(params.get('after'));
	if (after && !order) throw badRequest('after requires order=created', 'invalid_after');
	const parsed: SearchParams = {
		q,
		tags: params.getAll('tag'),
		scopes,
		limit: boundedInteger(params.get('limit'), 'limit', SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT),
		includeSuperseded: booleanParam(params, 'includeSuperseded'),
		includeExpired: booleanParam(params, 'includeExpired'),
		flagged: booleanParam(params, 'flagged'),
		watch: booleanParam(params, 'watch'),
	};
	if (booleanParam(params, 'includeWithdrawn')) parsed.includeWithdrawn = true;
	if (order) parsed.order = order;
	if (after) parsed.after = after;
	return parsed;
}

const EARLIEST = new Date(-8.64e15);
const SCAN_PAGE = 100;
// Vectors are only comparable within one model's space, so a builder needs the model beside the vector.
const SCAN_FIELDS = [...VIEW_FIELDS, 'embedding', 'embeddingModel'];

export function createdOrderConditions(
	comparator: 'less_than' | 'greater_than',
	position: CreatedPosition,
): Condition[] {
	const { createdAt, id } = position;
	return [
		// A plain range on `createdAt` first, so Harper can scan its index from the cursor; an `or` cannot drive a scan.
		{ attribute: 'createdAt', comparator: `${comparator}_equal`, value: createdAt },
		{
			operator: 'or',
			conditions: [
				{ attribute: 'createdAt', comparator, value: createdAt },
				{ attribute: 'id', comparator, value: id },
			],
		},
	];
}

export function unexpiredCondition(now: Date): Condition {
	return anyOf([
		{ attribute: 'validUntil', comparator: 'equals', value: null },
		{ attribute: 'validUntil', comparator: 'greater_than', value: now },
	]);
}

export interface ScanOptions {
	after?: { createdAt: Date | string | number; id: string };
	includeInactive?: boolean;
}

/**
 * Every stored memory row in `createdAt`, then id, order, for trusted in-process builders: no principal, no scope
 * conditions. Paged, so a slow consumer never holds a read open across the walk; a walk, not a snapshot.
 */
export async function* scanMemories(options: ScanOptions = {}): AsyncGenerator<Record<string, unknown>> {
	let after: CreatedPosition | undefined;
	if (options.after !== undefined) {
		// A Date from another app's realm is not a Date to Harper; this one is.
		const createdAt = new Date(options.after?.createdAt as any);
		if (Number.isNaN(createdAt.getTime()) || typeof options.after?.id !== 'string') {
			throw new TypeError('scanMemories: after must be { createdAt, id } from a scanned row');
		}
		after = { createdAt, id: options.after.id };
	}
	const filter: Condition[] = options.includeInactive
		? []
		: [{ attribute: 'status', comparator: 'equals', value: STATUS_ACTIVE }, unexpiredCondition(new Date())];
	const Memory = memoryTable();
	for (;;) {
		const page = await collect(
			Memory.search(
				{
					conditions: [
						...(after
							? createdOrderConditions('greater_than', after)
							: [{ attribute: 'createdAt', comparator: 'greater_than_equal', value: EARLIEST }]),
						...filter,
					],
					enforceExecutionOrder: true,
					sort: { attribute: 'createdAt', next: { attribute: 'id' } },
					select: SCAN_FIELDS,
					limit: SCAN_PAGE,
				},
				{ authorize: false },
			),
		);
		const last = page[SCAN_PAGE - 1];
		// Copied before the consumer sees the row: a Date stays mutable inside a frozen row.
		after = last && { createdAt: new Date(last.createdAt), id: last.id };
		yield* page;
		if (after === undefined) return;
	}
}

function filterConditions(params: SearchParams, principal: Principal, now = new Date()): Condition[] {
	const statuses = params.includeSuperseded ? [STATUS_ACTIVE, STATUS_SUPERSEDED] : [STATUS_ACTIVE];
	if (params.includeWithdrawn) statuses.push(STATUS_WITHDRAWN);
	const conditions: Condition[] = [
		anyOf(statuses.map((status) => ({ attribute: 'status', comparator: 'equals', value: status }))),
	];
	if (!params.includeExpired) conditions.push(unexpiredCondition(now));
	for (const tag of params.tags) conditions.push({ attribute: 'tags', comparator: 'equals', value: tag });
	if (params.flagged) conditions.push({ attribute: 'contentFlagged', comparator: 'equals', value: true });
	if (params.scopes.length > 0) {
		conditions.push(anyOf(params.scopes.map((label) => ({ attribute: 'scopes', comparator: 'equals', value: label }))));
	}
	conditions.push(...readableConditions(principal));
	return conditions;
}

const rejectedModels = new Set<string>();
const LANE_WARN_INTERVAL_MS = 60_000;
let lastEmbedWarning = 0;
let lastFullTextWarning = 0;

// Harper's fixed-dimension HNSW index rejects incompatible query vectors; full-text remains usable.
export function isVectorDimensionMismatch(error: any): boolean {
	return error?.statusCode === 400 && String(error?.message).startsWith('Search target has ');
}

export function reportVectorLaneRejected(model: string, error: Error): void {
	if (rejectedModels.has(model)) return;
	rejectedModels.add(model);
	logger.error?.(`[agent-memory] vector search rejected for embeddingModel "${model}"`, error);
}

function reportEmbedFailure(model: string, error: unknown): void {
	const now = Date.now();
	if (now - lastEmbedWarning < LANE_WARN_INTERVAL_MS) return;
	lastEmbedWarning = now;
	logger.warn?.(
		`[agent-memory] query embedding failed for embeddingModel "${model}"; serving full-text results only`,
		error,
	);
}

function isFullTextQueryRejected(error: any): boolean {
	return error?.statusCode === 400 && String(error?.message).startsWith("Full-text query on 'text' is invalid");
}

function reportFullTextRejected(): void {
	const now = Date.now();
	if (now - lastFullTextWarning < LANE_WARN_INTERVAL_MS) return;
	lastFullTextWarning = now;
	logger.warn?.('[agent-memory] full-text query rejected (400); serving vector results only');
}

export async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
	const records = [];
	for await (const record of iterable) records.push(record);
	return records;
}

// The conditions already exclude unreadable rows; this re-check only catches a defect in them.
export function assertReadable(records: any[], principal: Principal): any[] {
	return records.filter((record) => {
		if (canRead(record, principal)) return true;
		logger.error?.(`[agent-memory] search returned unreadable memory ${record.id}; dropped`);
		return false;
	});
}

export function fuse<T extends { id: string }>(lanes: readonly (readonly T[])[], k = RRF_K) {
	const fused = new Map<string, { record: T; score: number }>();
	for (const lane of lanes) {
		lane.forEach((record, index) => {
			const entry = fused.get(record.id) ?? { record, score: 0 };
			entry.score += 1 / (k + index + 1);
			fused.set(record.id, entry);
		});
	}
	return [...fused.values()].sort(
		(a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
	);
}

// Checked with canRead rather than as conditions, so a narrow caller's probe stops after one page of another
// tenant's bulk write.
async function indexWaitMilliseconds(Memory: any, principal: Principal, context: object): Promise<number> {
	let scanned = 0;
	for await (const record of Memory.search(
		{
			conditions: [
				{
					attribute: 'updatedAt',
					comparator: 'greater_than_equal',
					value: new Date(Date.now() - RECENT_WRITE_WINDOW_MS),
				},
			],
			select: ['id', 'ownerId', 'scopes', 'status', 'contentFlag'],
			limit: RECENT_WRITE_SCAN,
		},
		context,
	)) {
		if (canRead(record, principal)) return INDEX_WAIT_MS;
		scanned++;
	}
	return scanned === RECENT_WRITE_SCAN ? INDEX_WAIT_MS : 0;
}

async function laneSearch(run: (freshness: object) => Promise<any[]>, waitMs: number): Promise<any[]> {
	if (waitMs > 0) return run({ waitForIndexMilliseconds: waitMs });
	try {
		return await run({ waitForIndexMilliseconds: 0, maxIndexLagMilliseconds: INDEX_LAG_MS });
	} catch (error: any) {
		if (error?.code !== INDEX_LAGGING) throw error;
		return run({ waitForIndexMilliseconds: INDEX_WAIT_MS });
	}
}

export async function searchMemories(
	params: SearchParams,
	principal: Principal,
	context: object,
	access?: Map<string, Promise<any>>,
) {
	// Withdrawn rows are readable by their owner and super_user only; listing them is for a full export.
	if (params.includeWithdrawn && !principal.superUser) {
		throw memoryError('includeWithdrawn requires super_user', 403, 'include_withdrawn_forbidden');
	}
	const settings = getSettings();
	const { embeddingModel } = settings;
	const Memory = memoryTable();
	const conditions = filterConditions(params, principal);
	if (!params.q) {
		const recent = await collect(
			Memory.search(
				params.order === 'created'
					? {
							conditions: [
								...(params.after
									? createdOrderConditions('greater_than', params.after)
									: [{ attribute: 'createdAt', comparator: 'greater_than_equal', value: EARLIEST }]),
								...conditions,
							],
							// A walk of everything (a super_user, no tag, scope or flagged filter) pins the createdAt range to drive the
							// scan; a narrower listing lets Harper start from its most selective condition and sort the few rows.
							enforceExecutionOrder:
								principal.superUser && params.tags.length === 0 && params.scopes.length === 0 && !params.flagged,
							sort: { attribute: 'createdAt', next: { attribute: 'id' } },
							select: VIEW_FIELDS,
							limit: params.limit,
						}
					: {
							conditions,
							sort: { attribute: 'updatedAt', descending: true },
							select: VIEW_FIELDS,
							limit: params.limit,
						},
				context,
			),
		);
		const results = await forReader(assertReadable(recent, principal).map(toMemoryView), principal, context, access);
		if (params.watch) {
			await recordWatches(
				results.map((view) => view.id),
				principal,
				WATCH_DEFAULT_TTL_SECONDS,
				context,
			);
		}
		return results;
	}
	const laneLimit = Math.min(params.limit * 2, 100);
	const waitMs = await indexWaitMilliseconds(Memory, principal, context);
	let vector: ArrayLike<number> | undefined;
	let embeddingFailed = false;
	let embeddingError: unknown;
	try {
		[vector] = await embedTexts(
			params.q,
			{ model: embeddingModel, inputType: 'query' },
			settings,
			settings.embeddingTruncate,
		);
		if (!vector?.length) throw new Error('Query embedding returned no vector');
	} catch (error) {
		embeddingFailed = true;
		embeddingError = error;
	}
	const vectorLane = async () => {
		if (embeddingFailed) throw embeddingError;
		if (!vector) throw new Error('Query embedding returned no vector');
		const target = Array.from(vector);
		const hits = await laneSearch(
			(freshness) =>
				collect(
					Memory.search(
						{
							// Rows embedded by another model live in another vector space.
							conditions: [...conditions, { attribute: 'embeddingModel', comparator: 'equals', value: embeddingModel }],
							sort: { attribute: 'embedding', target, ...freshness },
							select: VIEW_FIELDS,
							limit: laneLimit,
						},
						context,
					),
				),
			waitMs,
		);
		rejectedModels.delete(embeddingModel);
		return hits;
	};
	const textLane = async () =>
		laneSearch(
			(freshness) =>
				collect(
					Memory.search(
						{
							conditions: [...conditions, { attribute: 'text', comparator: 'matches', value: params.q, ...freshness }],
							select: VIEW_FIELDS,
							limit: laneLimit,
						},
						context,
					),
				),
			waitMs,
		);
	const [vectorResult, textResult] = await Promise.allSettled([vectorLane(), textLane()]);
	if (vectorResult.status === 'rejected' && textResult.status === 'rejected') {
		if (!embeddingFailed && isVectorDimensionMismatch(vectorResult.reason)) {
			reportVectorLaneRejected(embeddingModel, vectorResult.reason);
		}
		if (embeddingFailed && !isFullTextQueryRejected(textResult.reason)) throw textResult.reason;
		if (embeddingFailed || !isVectorDimensionMismatch(vectorResult.reason)) throw vectorResult.reason;
		throw textResult.reason;
	}
	if (vectorResult.status === 'rejected') {
		if (embeddingFailed) reportEmbedFailure(embeddingModel, vectorResult.reason);
		else if (isVectorDimensionMismatch(vectorResult.reason)) {
			reportVectorLaneRejected(embeddingModel, vectorResult.reason);
		} else throw vectorResult.reason;
	}
	if (textResult.status === 'rejected') {
		if (!isFullTextQueryRejected(textResult.reason)) throw textResult.reason;
		reportFullTextRejected();
	}
	const vectorHits = vectorResult.status === 'fulfilled' ? vectorResult.value : [];
	const textHits = textResult.status === 'fulfilled' ? textResult.value : [];
	const ranked = fuse([assertReadable(vectorHits, principal), assertReadable(textHits, principal)]).slice(
		0,
		params.limit,
	);
	const views = await forReader(
		ranked.map(({ record }) => toMemoryView(record)),
		principal,
		context,
		access,
	);
	const results = views.map((view, index) => ({ ...view, score: ranked[index].score }));
	if (params.watch) {
		await recordWatches(
			results.map((view) => view.id),
			principal,
			WATCH_DEFAULT_TTL_SECONDS,
			context,
		);
	}
	return results;
}

export interface BootstrapParams {
	q?: string;
	budget: number;
	watch?: boolean;
}

export function parseBootstrapParams(params: URLSearchParams): BootstrapParams {
	return {
		q: optionalQuery(params.get('q')),
		budget: boundedInteger(params.get('budget'), 'budget', BOOTSTRAP_DEFAULT_BUDGET, BOOTSTRAP_MAX_BUDGET),
		watch: booleanParam(params, 'watch'),
	};
}

export async function bootstrapMemories(params: BootstrapParams, principal: Principal, context: object) {
	const Memory = memoryTable();
	const MemoryPin = memoryPinTable();
	const active = { attribute: 'status', comparator: 'equals', value: STATUS_ACTIVE };
	const unexpired = unexpiredCondition(new Date());
	const readable = readableConditions(principal);
	const recentFirst = { attribute: 'updatedAt', descending: true };
	// One lookup per flag source across every section.
	const access = new Map<string, Promise<any>>();
	const loadPinned = async () => {
		const pins = await collect(
			MemoryPin.search(
				{
					conditions: [{ attribute: 'principalId', comparator: 'equals', value: principal.id }],
					sort: { attribute: 'createdAt', descending: true },
					select: ['memoryId'],
					limit: BOOTSTRAP_PINNED_LIMIT,
				},
				context,
			),
		);
		if (pins.length === 0) return [];
		const pinIds = anyOf(pins.map((pin) => ({ attribute: 'id', comparator: 'equals', value: pin.memoryId })));
		const records = await collect(
			Memory.search(
				{
					conditions: [active, unexpired, pinIds, ...readable],
					select: VIEW_FIELDS,
					limit: BOOTSTRAP_PINNED_LIMIT,
				},
				context,
			),
		);
		const views = await forReader(assertReadable(records, principal).map(toMemoryView), principal, context, access);
		const byId = new Map(views.map((view) => [view.id, view]));
		return pins
			.map((pin) => byId.get(pin.memoryId))
			.filter((view): view is NonNullable<typeof view> => view !== undefined);
	};
	// The caller's own flagged memories; the indexed mirror of the flag's date keeps this off a scan of every owned row.
	const loadNeedsReview = async () => {
		const visible: MemoryView[] = [];
		let chunk: any[] = [];
		const admit = async () => {
			for (const view of await forReader(chunk.map(toMemoryView), principal, context, access)) {
				if (view.needsReview && visible.length < BOOTSTRAP_REVIEW_LIMIT) visible.push(view);
			}
			chunk = [];
		};
		for await (const record of Memory.search(
			{
				conditions: [
					active,
					unexpired,
					{ attribute: 'ownerId', comparator: 'equals', value: principal.id },
					{ attribute: 'needsReviewSince', comparator: 'greater_than', value: new Date(0) },
				],
				sort: { attribute: 'needsReviewSince', descending: true },
				select: VIEW_FIELDS,
				limit: BOOTSTRAP_REVIEW_SCAN,
			},
			context,
		)) {
			chunk.push(record);
			if (chunk.length < BOOTSTRAP_REVIEW_LIMIT) continue;
			await admit();
			if (visible.length === BOOTSTRAP_REVIEW_LIMIT) break;
		}
		if (chunk.length > 0) await admit();
		return visible;
	};
	const seen = new Set<string>();
	const memories: Record<string, unknown>[] = [];
	let used = 0;
	const fits = (title: unknown, content: unknown) => {
		const size = String(title ?? '').length + String(content ?? '').length;
		if (used + size > params.budget) return false;
		used += size;
		return true;
	};
	const pack = (section: string, records: readonly MemoryView[]) => {
		for (const memory of records) {
			if (seen.has(memory.id) || !fits(memory.title, memory.content)) continue;
			seen.add(memory.id);
			memories.push({ ...memory, section });
		}
	};
	const sections = registeredBootstrapSections();
	// Contributed sections render once pinned and needsReview have packed, so they know the budget left, while recent
	// and relevant still load. Awaiting head on its own would leave a recent or relevant rejection unobserved.
	const head = Promise.all([loadPinned(), loadNeedsReview()]).then(([pinned, needsReview]) => {
		pack('pinned', pinned);
		pack('needsReview', needsReview);
		if (sections.length === 0) return;
		return renderBootstrapSections(sections, {
			principal,
			q: params.q,
			budgetChars: params.budget - used,
			context,
		}).then((rendered) => {
			for (const { name, items } of rendered) {
				// No id: clients must not watch, cache or deduplicate contributed text as a memory.
				for (const item of items) {
					if (fits(item.title, item.content))
						memories.push({ title: item.title ?? null, content: item.content, section: name });
				}
			}
		});
	});
	const [, recent, relevant] = await Promise.all([
		head,
		collect(
			Memory.search(
				{
					conditions: [active, unexpired, { attribute: 'ownerId', comparator: 'equals', value: principal.id }],
					sort: recentFirst,
					select: VIEW_FIELDS,
					limit: BOOTSTRAP_RECENT_LIMIT,
				},
				context,
			),
		).then((records) => forReader(records.map(toMemoryView), principal, context, access)),
		params.q
			? searchMemories(
					{
						q: params.q,
						tags: [],
						scopes: [],
						limit: BOOTSTRAP_RELEVANT_LIMIT,
						includeSuperseded: false,
						includeExpired: false,
						watch: false,
					},
					principal,
					context,
					access,
				).then((hits) => hits.map(({ score: _score, ...memory }) => memory))
			: [],
	]);
	pack('recent', recent);
	pack('relevant', relevant);
	if (params.watch) await recordWatches([...seen], principal, WATCH_DEFAULT_TTL_SECONDS, context);
	return { memories, budget: params.budget, used };
}
