// Memory ids are 16-64 characters, so the 9-char `bootstrap` and 6-char `import` path segments cannot collide with one.
import { logger, Resource } from 'harper';
import { badRequest, isCallerSafe, memoryError, notFound } from './errors.ts';
import { importMemories } from './import.ts';
import { confirmMemory, getMemory, pinMemory, putMemory, unpinMemory, withdrawMemory } from './lifecycle.ts';
import { resolvePrincipal } from './principal.ts';
import type { Principal } from './scopes.ts';
import { bootstrapMemories, parseBootstrapParams, parseSearchParams, searchMemories } from './search.ts';

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

async function readBody(data: unknown): Promise<unknown> {
	try {
		return (await data) ?? {};
	} catch {
		throw badRequest('Request body must be valid JSON', 'invalid_body');
	}
}

// Harper's retryable failures: 503 (an index rebuilding or lagging, a database closing), 423 (a record lock not
// granted in time), the 409 a lock lease that lapsed before commit raises, and transient embedding backend
// failures (429, 5xx, timeout, connection failure), whether wrapped by Harper's embedHook or raised by the
// plugin's own embedding before a write. Any other 409 (a sink inserting a row that exists) is a defect, not a
// reason to retry.
function isRetryable(error: any): boolean {
	const status = error?.statusCode;
	const message = String(error?.message ?? '');
	if (status === 503 || status === 423 || (status === 409 && message.startsWith('Record lock'))) return true;
	const upstream = error?.upstreamStatus ?? error?.cause?.upstreamStatus ?? error?.cause?.status;
	if (upstream === 429 || (typeof upstream === 'number' && upstream >= 500 && upstream <= 599)) return true;
	if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
	if (error?.name === 'TypeError' && message === 'fetch failed') return true;
	return /^Failed to compute embedding for attribute "embedding"(?: \[(?:AbortError|TimeoutError|TypeError)\]|.*\(backend HTTP (?:429|5\d\d)\))/.test(
		message,
	);
}

const RETRYABLE_WARN_INTERVAL_MS = 60_000;
let lastRetryableWarning = 0;

function errorResponse(error: unknown, route: string): Response {
	if (isCallerSafe(error)) {
		const body: Record<string, unknown> = { error: error.message, code: error.code };
		if (error.index !== undefined) body.index = error.index;
		return json(body, error.statusCode);
	}
	// The fixed message keeps Harper's text, which is not vetted for callers, out of the response; the log keeps
	// a persistent condition diagnosable without logging every request.
	if (isRetryable(error)) {
		const now = Date.now();
		if (now - lastRetryableWarning >= RETRYABLE_WARN_INTERVAL_MS) {
			lastRetryableWarning = now;
			logger.warn?.(`[agent-memory] ${route} answered 503 for a retryable failure`, error);
		}
		return json({ error: 'Temporarily unavailable; retry shortly', code: 'unavailable' }, 503);
	}
	logger.error?.(`[agent-memory] ${route} failed`, error);
	return json({ error: 'Internal error', code: 'internal_error' }, 500);
}

async function handle(
	route: string,
	context: object | undefined,
	fn: (principal: Principal, ctx: object) => Promise<Response>,
): Promise<Response> {
	try {
		const ctx = (context ?? {}) as Record<string, unknown>;
		// Static verb overrides replace Resource's transactional() wrapper, which otherwise consumes
		// the HTTP entry `request.authorize` flag before any internal table read runs in this async scope.
		ctx.authorize = false;
		const principal = await resolvePrincipal(ctx);
		return await fn(principal, ctx);
	} catch (error) {
		return errorResponse(error, route);
	}
}

const MEMORY_ACTIONS = ['pin', 'unpin', 'confirm'];

function rejectUnsupportedVerb(target: any): never {
	if (target?.rest || target?.pathname) throw notFound();
	if (target?.action !== undefined && !MEMORY_ACTIONS.includes(target.action)) throw notFound();
	throw memoryError('Method not allowed', 405, 'method_not_allowed');
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
class MemoryEndpoint extends Resource {
	// Kept out of MCP and OpenAPI auto-export: the generic verbs would not express these routes.
	static hidden = true;

	static async get(target: any, context: object) {
		return handle('get', context, async () => rejectUnsupportedVerb(target));
	}

	static async post(target: any, _data: any, context: object) {
		return handle('post', context, async () => rejectUnsupportedVerb(target));
	}

	static async put(target: any, _data: any, context: object) {
		return handle('put', context, async () => rejectUnsupportedVerb(target));
	}

	static async delete(target: any, context: object) {
		return handle('delete', context, async () => rejectUnsupportedVerb(target));
	}

	static async patch(target: any, _data: any, context: object) {
		return handle('patch', context, async () => rejectUnsupportedVerb(target));
	}
}

export class MemoryResource extends MemoryEndpoint {
	static path = '/Memory/*rest';

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			if (target?.rest) throw notFound();
			return json({ memories: await searchMemories(parseSearchParams(target), principal, ctx) });
		});
	}
}

export class MemoryBootstrapResource extends MemoryEndpoint {
	static path = '/Memory/bootstrap';

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			if (target?.pathname) throw notFound();
			return json(await bootstrapMemories(parseBootstrapParams(target), principal, ctx));
		});
	}
}

export class MemoryImportResource extends MemoryEndpoint {
	static path = '/Memory/import';

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			if (target?.pathname) throw notFound();
			return json(await importMemories(await readBody(data), principal, ctx));
		});
	}
}

export class MemoryItemResource extends MemoryEndpoint {
	static path = '/Memory/:id';

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			const memory = await getMemory(String(target?.id ?? ''), principal, ctx);
			if (!memory) throw notFound();
			return json({ memory }, 200, { ETag: `"${memory.revision}"` });
		});
	}

	static async put(target: any, data: any, context: object) {
		return handle('put', context, async (principal, ctx) => {
			const { id, revision, created, candidates } = await putMemory(
				String(target?.id ?? ''),
				await readBody(data),
				principal,
				ctx,
			);
			return json({ id, revision, candidates }, created ? 201 : 200);
		});
	}

	static async delete(target: any, context: object) {
		return handle('delete', context, async (principal, ctx) => {
			const reason = target?.get?.('reason');
			const input = reason === undefined ? {} : { reason };
			return json({ memory: await withdrawMemory(String(target?.id ?? ''), input, principal, ctx) });
		});
	}
}

export class MemoryActionResource extends MemoryEndpoint {
	static path = '/Memory/:id/:action';

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			const id = String(target?.id ?? '');
			const input = await readBody(data);
			switch (target?.action) {
				case 'pin':
					return json(await pinMemory(id, input, principal, ctx));
				case 'unpin':
					return json(await unpinMemory(id, input, principal, ctx));
				case 'confirm':
					return json({ memory: await confirmMemory(id, input, principal, ctx) });
				default:
					throw notFound();
			}
		});
	}
}

export const MEMORY_RESOURCES = [
	MemoryResource,
	MemoryBootstrapResource,
	MemoryImportResource,
	MemoryItemResource,
	MemoryActionResource,
] as const;
