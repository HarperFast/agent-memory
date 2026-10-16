// Memory ids are 32 hex characters, so the `bootstrap` and `import` path segments cannot collide with one.
import { logger, Resource } from 'harper';
import { badRequest, isCallerSafe, notFound } from './errors.ts';
import { importMemories } from './import.ts';
import {
	createMemory,
	getMemory,
	pinMemory,
	reviseMemory,
	setMemoryScopes,
	unpinMemory,
	withdrawMemory,
} from './lifecycle.ts';
import { resolvePrincipal } from './principal.ts';
import type { Principal } from './scopes.ts';
import { bootstrapMemories, parseBootstrapParams, parseSearchParams, searchMemories } from './search.ts';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function readBody(data: unknown): Promise<unknown> {
	try {
		return (await data) ?? {};
	} catch {
		throw badRequest('Request body must be valid JSON', 'invalid_body');
	}
}

// Harper's retryable failures: 503 (an index rebuilding or lagging, a database closing), 423 (a record lock not
// granted in time) and the 409 a lock lease that lapsed before commit raises. Any other 409 (a sink inserting a
// row that exists) is a defect, not a reason to retry.
function isRetryable(error: any): boolean {
	const status = error?.statusCode;
	return status === 503 || status === 423 || (status === 409 && String(error?.message).startsWith('Record lock'));
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

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
export class MemoryResource extends Resource {
	static path = '/Memory/*rest';
	// Kept out of MCP and OpenAPI auto-export: the generic verbs would not express these routes.
	static hidden = true;

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			if (target?.rest) throw notFound();
			return json({ memories: await searchMemories(parseSearchParams(target), principal, ctx) });
		});
	}

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			if (target?.rest) throw notFound();
			const { memory, created } = await createMemory(await readBody(data), principal, ctx);
			return json({ memory, created }, created ? 201 : 200);
		});
	}
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
export class MemoryBootstrapResource extends Resource {
	static path = '/Memory/bootstrap';
	static hidden = true;

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			if (target?.pathname) throw notFound();
			return json(await bootstrapMemories(parseBootstrapParams(target), principal, ctx));
		});
	}
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
export class MemoryImportResource extends Resource {
	static path = '/Memory/import';
	static hidden = true;

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			if (target?.pathname) throw notFound();
			return json(await importMemories(await readBody(data), principal, ctx));
		});
	}
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
export class MemoryItemResource extends Resource {
	static path = '/Memory/:id';
	static hidden = true;

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			const memory = await getMemory(String(target?.id ?? ''), principal, ctx);
			if (!memory) throw notFound();
			return json({ memory });
		});
	}
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
export class MemoryActionResource extends Resource {
	static path = '/Memory/:id/:action';
	static hidden = true;

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			const id = String(target?.id ?? '');
			const input = await readBody(data);
			switch (target?.action) {
				case 'revise':
					return json({ memory: await reviseMemory(id, input, principal, ctx) });
				case 'scopes':
					return json({ memory: await setMemoryScopes(id, input, principal, ctx) });
				case 'withdraw':
					return json({ memory: await withdrawMemory(id, input, principal, ctx) });
				case 'pin':
					return json(await pinMemory(id, input, principal, ctx));
				case 'unpin':
					return json(await unpinMemory(id, input, principal, ctx));
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
