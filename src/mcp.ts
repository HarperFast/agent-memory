import { randomUUID } from 'node:crypto';
import { badRequest, isCallerSafe, memoryError, normalizeError, notFound } from './errors.ts';
import { WATCH_MAX_IDS, WATCH_MAX_TTL_SECONDS, watchMemories } from './events.ts';
import {
	confirmMemory,
	confirmScopeMemory,
	EVIDENCE_KINDS,
	getMemory,
	isMemoryId,
	pinMemory,
	putMemory,
	rejectUnknownFields,
	unpinMemory,
	withdrawMemory,
} from './lifecycle.ts';
import { resolvePrincipal } from './principal.ts';
import { isScopeLabel, type Principal } from './scopes.ts';
import { searchMemories, type SearchParams } from './search.ts';

const REMEMBER_FIELDS = [
	'id',
	'title',
	'content',
	'tags',
	'scopes',
	'visibility',
	'evidence',
	'validUntil',
	'supersedes',
] as const;

const REVISE_FIELDS = [
	'id',
	'revision',
	'title',
	'content',
	'tags',
	'scopes',
	'visibility',
	'evidence',
	'validUntil',
	'supersedes',
] as const;

const RECALL_FIELDS = [
	'q',
	'tags',
	'tag',
	'scopes',
	'scope',
	'limit',
	'includeSuperseded',
	'includeExpired',
	'flagged',
	'watch',
] as const;

const SEARCH_MAX_LIMIT = 50;
const SEARCH_DEFAULT_LIMIT = 10;
const QUERY_MAX_CHARS = 1000;

const EVIDENCE_ITEM_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['kind', 'ref'],
	properties: {
		kind: { type: 'string', enum: [...EVIDENCE_KINDS] },
		ref: { type: 'string' },
		note: { type: 'string' },
	},
} as const;

export const MEMORY_MCP_TOOLS = [
	{
		name: 'remember',
		method: 'mcpRemember',
		description: 'Create a memory (or idempotently retry an identical create).',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['title', 'content'],
			properties: {
				id: {
					type: 'string',
					description: 'Optional client-chosen memory id (16–64 alphanumeric, _ or - chars; defaults to a UUID).',
				},
				title: { type: 'string' },
				content: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
				scopes: { type: 'array', items: { type: 'string' } },
				visibility: { type: 'string', enum: ['private', 'shared'] },
				evidence: { type: 'array', items: EVIDENCE_ITEM_SCHEMA },
				validUntil: { type: ['string', 'null'] },
				supersedes: { type: 'array', items: { type: 'string' } },
			},
		},
	},
	{
		name: 'revise',
		method: 'mcpRevise',
		description: 'Revise an existing owned memory at a specific revision.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id', 'revision'],
			properties: {
				id: { type: 'string' },
				revision: { type: 'integer', minimum: 1 },
				title: { type: 'string' },
				content: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
				scopes: { type: 'array', items: { type: 'string' } },
				visibility: { type: 'string', enum: ['private', 'shared'] },
				evidence: { type: 'array', items: EVIDENCE_ITEM_SCHEMA },
				validUntil: { type: ['string', 'null'] },
			},
		},
	},
	{
		name: 'recall',
		method: 'mcpRecall',
		description: 'Search readable memories using hybrid vector and full-text search, optionally watching results.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				q: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
				tag: {
					oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
				},
				scopes: { type: 'array', items: { type: 'string' } },
				scope: {
					oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
				},
				limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_LIMIT },
				includeSuperseded: { type: 'boolean' },
				includeExpired: { type: 'boolean' },
				flagged: { type: 'boolean', description: 'Only memories flagged for possible customer detail.' },
				watch: { type: 'boolean' },
			},
		},
	},
	{
		name: 'get',
		method: 'mcpGet',
		description: 'Read a single memory by id.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string' },
			},
		},
	},
	{
		name: 'withdraw',
		method: 'mcpWithdraw',
		description: 'Withdraw an owned memory as a tombstone at a specific revision.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id', 'revision'],
			properties: {
				id: { type: 'string' },
				revision: { type: 'integer', minimum: 1 },
				reason: { type: 'string' },
			},
		},
	},
	{
		name: 'pin',
		method: 'mcpPin',
		description: 'Pin a readable memory for session bootstrap.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string' },
			},
		},
	},
	{
		name: 'unpin',
		method: 'mcpUnpin',
		description: 'Remove a memory pin.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string' },
			},
		},
	},
	{
		name: 'confirm',
		method: 'mcpConfirm',
		description: 'Confirm an owned memory after reviewing its flagged evidence.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string' },
				revision: { type: 'integer', minimum: 1 },
			},
		},
	},
	{
		name: 'confirm-scope',
		method: 'mcpConfirmScope',
		description:
			'Confirm that a memory flagged for possible customer detail may stay global (requires customer:* write).',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string' },
				revision: { type: 'integer', minimum: 1 },
			},
		},
	},
	{
		name: 'watch',
		method: 'mcpWatch',
		description: 'Watch readable memory ids for changes on /MemoryEvents.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['ids'],
			properties: {
				ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: WATCH_MAX_IDS },
				ttlSeconds: { type: 'integer', minimum: 1, maximum: WATCH_MAX_TTL_SECONDS },
			},
		},
	},
] as const;

export const MEMORY_MCP_RESOURCES = [
	{
		name: 'memory',
		uriTemplate: 'memory:///{id}',
		description: 'Guarded view of a readable memory by id.',
		mimeType: 'application/json',
		method: 'mcpReadMemory',
	},
] as const;

function mcpLifecycleContext(rawContext: Record<string, unknown>, ifMatch?: string): Record<string, unknown> {
	const headers: Record<string, string> = {};
	if (ifMatch !== undefined) headers['if-match'] = ifMatch;
	return Object.assign(Object.create(rawContext), {
		authorize: false,
		user: rawContext.user,
		headers,
	});
}

function formatRevision(revision: unknown): string {
	if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
		throw badRequest('revision must be a positive integer', 'invalid_revision');
	}
	return `"${revision}"`;
}

function collectStringFilter(first: unknown, second: unknown, field: string, errorCode: string): string[] {
	const out: string[] = [];
	for (const source of [first, second]) {
		if (source === undefined || source === null) continue;
		const items = Array.isArray(source) ? source : [source];
		for (const item of items) {
			if (typeof item !== 'string') {
				throw badRequest(`${field} must be a string or array of strings`, errorCode);
			}
			out.push(item);
		}
	}
	return out;
}

function parseRecallParams(input: unknown): SearchParams {
	const payload = rejectUnknownFields(input ?? {}, RECALL_FIELDS, 'recall');
	let q: string | undefined;
	if (payload.q !== undefined && payload.q !== null) {
		if (typeof payload.q !== 'string') throw badRequest('q must be a string', 'invalid_q');
		const trimmed = payload.q.trim();
		if (trimmed.length > QUERY_MAX_CHARS) {
			throw badRequest(`q exceeds ${QUERY_MAX_CHARS} characters`, 'q_too_long');
		}
		if (trimmed.length > 0) q = trimmed;
	}

	const tags = collectStringFilter(payload.tags, payload.tag, 'tags', 'invalid_tags');
	const scopes = collectStringFilter(payload.scopes, payload.scope, 'scopes', 'invalid_scope_label');
	if (!scopes.every(isScopeLabel)) {
		throw badRequest('scope must be a scope label', 'invalid_scope_label');
	}

	let limit = SEARCH_DEFAULT_LIMIT;
	if (payload.limit !== undefined && payload.limit !== null) {
		if (
			typeof payload.limit !== 'number' ||
			!Number.isInteger(payload.limit) ||
			payload.limit < 1 ||
			payload.limit > SEARCH_MAX_LIMIT
		) {
			throw badRequest(`limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}`, 'invalid_limit');
		}
		limit = payload.limit;
	}

	const booleanField = (name: 'includeSuperseded' | 'includeExpired' | 'flagged' | 'watch'): boolean => {
		const value = payload[name];
		if (value === undefined || value === null) return false;
		if (typeof value !== 'boolean') {
			throw badRequest(`${name} must be true or false`, `invalid_${name}`);
		}
		return value;
	};

	return {
		q,
		tags,
		scopes,
		limit,
		includeSuperseded: booleanField('includeSuperseded'),
		includeExpired: booleanField('includeExpired'),
		flagged: booleanField('flagged'),
		watch: booleanField('watch'),
	};
}

async function runMcpTool<T>(
	toolName: string,
	context: unknown,
	fn: (principal: Principal, rawContext: Record<string, unknown>) => Promise<T>,
): Promise<T> {
	try {
		const ctx = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
		ctx.authorize = false;
		const principal = await resolvePrincipal(ctx);
		return await fn(principal, ctx);
	} catch (error) {
		const safe = normalizeError(error, `mcp:${toolName}`);
		(safe as any).errors = [{ code: safe.code, status: safe.statusCode }];
		throw safe;
	}
}

export const MEMORY_MCP_METHODS = {
	mcpRemember(params: unknown, context: unknown) {
		return runMcpTool('remember', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, REMEMBER_FIELDS, 'remember');
			const { id: rawId, ...body } = payload;
			const id = rawId === undefined || rawId === null ? randomUUID() : rawId;
			const {
				id: memoryId,
				revision,
				created,
				memory,
				candidates,
			} = await putMemory(id, body, principal, mcpLifecycleContext(ctx));
			return { id: memoryId, revision, created, candidates, contentFlag: memory.contentFlag };
		});
	},

	mcpRevise(params: unknown, context: unknown) {
		return runMcpTool('revise', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, REVISE_FIELDS, 'revise');
			if (payload.supersedes !== undefined) {
				throw badRequest('supersedes is only allowed when creating a memory', 'supersedes_not_allowed');
			}
			const { id, revision, ...body } = payload;
			if (!isMemoryId(id)) {
				throw badRequest('Memory id must be 16-64 characters of A-Z, a-z, 0-9, _ or -', 'invalid_id');
			}
			if (revision === undefined || revision === null) {
				throw memoryError('If-Match header is required to revise an existing memory', 428, 'if_match_required');
			}
			const ifMatch = formatRevision(revision);
			const {
				id: memoryId,
				revision: nextRevision,
				created,
				memory,
				candidates,
			} = await putMemory(id, body, principal, mcpLifecycleContext(ctx, ifMatch));
			return { id: memoryId, revision: nextRevision, created, candidates, contentFlag: memory.contentFlag };
		});
	},

	mcpRecall(params: unknown, context: unknown) {
		return runMcpTool('recall', context, async (principal, ctx) => {
			const searchParams = parseRecallParams(params);
			const memories = await searchMemories(searchParams, principal, mcpLifecycleContext(ctx));
			return { memories };
		});
	},

	mcpGet(params: unknown, context: unknown) {
		return runMcpTool('get', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id'], 'get');
			const memory = await getMemory(String(payload.id ?? ''), principal, mcpLifecycleContext(ctx));
			if (!memory) throw notFound();
			return { memory };
		});
	},

	mcpWithdraw(params: unknown, context: unknown) {
		return runMcpTool('withdraw', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id', 'revision', 'reason'], 'withdraw');
			if (!isMemoryId(payload.id)) throw notFound();
			const ifMatch =
				payload.revision === undefined || payload.revision === null ? undefined : formatRevision(payload.revision);
			const body = payload.reason === undefined ? {} : { reason: payload.reason };
			const memory = await withdrawMemory(payload.id, body, principal, mcpLifecycleContext(ctx, ifMatch));
			return { memory };
		});
	},

	mcpPin(params: unknown, context: unknown) {
		return runMcpTool('pin', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id'], 'pin');
			return pinMemory(payload.id, {}, principal, mcpLifecycleContext(ctx));
		});
	},

	mcpUnpin(params: unknown, context: unknown) {
		return runMcpTool('unpin', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id'], 'unpin');
			return unpinMemory(payload.id, {}, principal, mcpLifecycleContext(ctx));
		});
	},

	mcpConfirm(params: unknown, context: unknown) {
		return runMcpTool('confirm', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id', 'revision'], 'confirm');
			if (!isMemoryId(payload.id)) throw notFound();
			const ifMatch =
				payload.revision === undefined || payload.revision === null ? undefined : formatRevision(payload.revision);
			const memory = await confirmMemory(payload.id, {}, principal, mcpLifecycleContext(ctx, ifMatch));
			return { memory };
		});
	},

	mcpConfirmScope(params: unknown, context: unknown) {
		return runMcpTool('confirm-scope', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['id', 'revision'], 'confirm-scope');
			if (!isMemoryId(payload.id)) throw notFound();
			const ifMatch =
				payload.revision === undefined || payload.revision === null ? undefined : formatRevision(payload.revision);
			const memory = await confirmScopeMemory(payload.id, {}, principal, mcpLifecycleContext(ctx, ifMatch));
			return { memory };
		});
	},

	mcpWatch(params: unknown, context: unknown) {
		return runMcpTool('watch', context, async (principal, ctx) => {
			const payload = rejectUnknownFields(params, ['ids', 'ttlSeconds'], 'watch');
			return watchMemories(payload, principal, mcpLifecycleContext(ctx));
		});
	},

	async mcpReadMemory(params: Record<string, string> | undefined, context: unknown) {
		try {
			const ctx = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
			ctx.authorize = false;
			const principal = await resolvePrincipal(ctx);
			return await getMemory(String(params?.id ?? ''), principal, mcpLifecycleContext(ctx));
		} catch (error) {
			if (isCallerSafe(error)) return undefined;
			const safe = normalizeError(error, 'mcp:read:memory');
			(safe as any).errors = [{ code: safe.code, status: safe.statusCode }];
			throw safe;
		}
	},
};
