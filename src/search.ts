import { logger, models } from 'harper';
import { badRequest } from './errors.ts';
import {
	BOOTSTRAP_PINNED_LIMIT,
	memoryPinTable,
	memoryTable,
	STATUS_ACTIVE,
	STATUS_SUPERSEDED,
	toMemoryView,
} from './lifecycle.ts';
import { anyOf, canRead, isScopeLabel, readableCondition, type Condition, type Principal } from './scopes.ts';
import { getSettings } from './settings.ts';

const RRF_K = 60;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_DEFAULT_LIMIT = 10;
const QUERY_MAX_CHARS = 1000;
// Both derived indexes apply commits after the fact; waiting for coverage of writes committed before the
// search keeps a memory searchable from the moment its create returns. An index that is already current
// does not wait.
const INDEX_WAIT_MS = 5000;
const BOOTSTRAP_DEFAULT_BUDGET = 8000;
const BOOTSTRAP_MAX_BUDGET = 100_000;
const BOOTSTRAP_RECENT_LIMIT = 50;
const BOOTSTRAP_RELEVANT_LIMIT = 20;

const VIEW_FIELDS = [
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
	'supersededBy',
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
	return {
		q: optionalQuery(params.get('q')),
		tags: params.getAll('tag'),
		scopes,
		limit: boundedInteger(params.get('limit'), 'limit', SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT),
		includeSuperseded: booleanParam(params, 'includeSuperseded'),
		includeExpired: booleanParam(params, 'includeExpired'),
	};
}

function unexpiredCondition(now: Date): Condition {
	return anyOf([
		{ attribute: 'validUntil', comparator: 'equals', value: null },
		{ attribute: 'validUntil', comparator: 'greater_than', value: now },
	]);
}

function filterConditions(params: SearchParams, principal: Principal, now = new Date()): Condition[] {
	const conditions: Condition[] = [
		anyOf(
			(params.includeSuperseded ? [STATUS_ACTIVE, STATUS_SUPERSEDED] : [STATUS_ACTIVE]).map((status) => ({
				attribute: 'status',
				comparator: 'equals',
				value: status,
			})),
		),
	];
	if (!params.includeExpired) conditions.push(unexpiredCondition(now));
	for (const tag of params.tags) conditions.push({ attribute: 'tags', comparator: 'equals', value: tag });
	if (params.scopes.length > 0) {
		conditions.push(anyOf(params.scopes.map((label) => ({ attribute: 'scopes', comparator: 'equals', value: label }))));
	}
	const readable = readableCondition(principal);
	if (readable) conditions.push(readable);
	return conditions;
}

const rejectedModels = new Set<string>();

function reportVectorLaneRejected(model: string, error: Error): void {
	if (rejectedModels.has(model)) return;
	rejectedModels.add(model);
	logger.error?.(
		`[agent-memory] vector search rejected for embeddingModel "${model}"; serving full-text results only`,
		error,
	);
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
	const records = [];
	for await (const record of iterable) records.push(record);
	return records;
}

// The conditions already exclude unreadable rows; this re-check only catches a defect in them.
function assertReadable(records: any[], principal: Principal): any[] {
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

export async function searchMemories(params: SearchParams, principal: Principal, context: object) {
	const { embeddingModel } = getSettings();
	const Memory = memoryTable();
	const conditions = filterConditions(params, principal);
	if (!params.q) {
		const recent = await collect(
			Memory.search(
				{ conditions, sort: { attribute: 'updatedAt', descending: true }, select: VIEW_FIELDS, limit: params.limit },
				context,
			),
		);
		return assertReadable(recent, principal).map(toMemoryView);
	}
	const laneLimit = Math.min(params.limit * 2, 100);
	const [vector] = await models.embed(params.q, { model: embeddingModel, inputType: 'query' });
	const vectorLane = async () =>
		collect(
			Memory.search(
				{
					// Rows embedded by another model live in another vector space.
					conditions: [...conditions, { attribute: 'embeddingModel', comparator: 'equals', value: embeddingModel }],
					sort: { attribute: 'embedding', target: Array.from(vector), waitForIndexMilliseconds: INDEX_WAIT_MS },
					select: VIEW_FIELDS,
					limit: laneLimit,
				},
				context,
			),
		);
	const [vectorHits, textHits] = await Promise.all([
		vectorLane().catch((error) => {
			// Harper rejects a query vector whose size differs from the index's as a client error; that means the
			// configured model no longer matches the stored vectors, and full-text results are still good.
			if (error?.statusCode !== 400) throw error;
			reportVectorLaneRejected(embeddingModel, error);
			return [];
		}),
		collect(
			Memory.search(
				{
					conditions: [
						...conditions,
						{ attribute: 'text', comparator: 'matches', value: params.q, waitForIndexMilliseconds: INDEX_WAIT_MS },
					],
					select: VIEW_FIELDS,
					limit: laneLimit,
				},
				context,
			),
		),
	]);
	return fuse([assertReadable(vectorHits, principal), assertReadable(textHits, principal)])
		.slice(0, params.limit)
		.map(({ record, score }) => ({ ...toMemoryView(record), score }));
}

export interface BootstrapParams {
	q?: string;
	budget: number;
}

export function parseBootstrapParams(params: URLSearchParams): BootstrapParams {
	return {
		q: optionalQuery(params.get('q')),
		budget: boundedInteger(params.get('budget'), 'budget', BOOTSTRAP_DEFAULT_BUDGET, BOOTSTRAP_MAX_BUDGET),
	};
}

export async function bootstrapMemories(params: BootstrapParams, principal: Principal, context: object) {
	const Memory = memoryTable();
	const MemoryPin = memoryPinTable();
	const active = { attribute: 'status', comparator: 'equals', value: STATUS_ACTIVE };
	const unexpired = unexpiredCondition(new Date());
	const readable = readableCondition(principal);
	const recentFirst = { attribute: 'updatedAt', descending: true };
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
					conditions: [active, unexpired, pinIds, ...(readable ? [readable] : [])],
					sort: recentFirst,
					select: VIEW_FIELDS,
					limit: BOOTSTRAP_PINNED_LIMIT,
				},
				context,
			),
		);
		return assertReadable(records, principal).map(toMemoryView);
	};
	const [pinned, recent, relevant] = await Promise.all([
		loadPinned(),
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
		).then((records) => records.map(toMemoryView)),
		params.q
			? searchMemories(
					{
						q: params.q,
						tags: [],
						scopes: [],
						limit: BOOTSTRAP_RELEVANT_LIMIT,
						includeSuperseded: false,
						includeExpired: false,
					},
					principal,
					context,
				).then((hits) => hits.map(({ score: _score, ...memory }) => memory))
			: [],
	]);
	const seen = new Set<unknown>();
	const memories = [];
	let used = 0;
	for (const [section, records] of [
		['pinned', pinned],
		['recent', recent],
		['relevant', relevant],
	] as const) {
		for (const memory of records) {
			if (seen.has(memory.id)) continue;
			const size = String(memory.title ?? '').length + String(memory.content ?? '').length;
			if (used + size > params.budget) continue;
			seen.add(memory.id);
			used += size;
			memories.push({ ...memory, section });
		}
	}
	return { memories, budget: params.budget, used };
}
