// Memory ids are 16-64 characters, so the 9-char `bootstrap` and 6-char `import` path segments cannot collide with one.
import { logger, Resource } from 'harper';
import { badRequest, isCallerSafe, memoryError, notFound, type MemoryError } from './errors.ts';
import { subscribeMemory, subscribeMemoryEvents, watchMemories } from './events.ts';
import { importMemories } from './import.ts';
import { confirmMemory, getMemory, pinMemory, putMemory, unpinMemory, withdrawMemory } from './lifecycle.ts';
import { MEMORY_MCP_METHODS, MEMORY_MCP_RESOURCES, MEMORY_MCP_TOOLS } from './mcp.ts';
import { resolvePrincipal } from './principal.ts';
import type { Principal } from './scopes.ts';
import { bootstrapMemories, parseBootstrapParams, parseSearchParams, searchMemories } from './search.ts';
import { getSettings } from './settings.ts';

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

export function normalizeError(error: unknown, route: string): MemoryError {
	if (isCallerSafe(error)) return error;
	// The fixed message keeps Harper's text, which is not vetted for callers, out of the response; the log keeps
	// a persistent condition diagnosable without logging every request.
	if (isRetryable(error)) {
		const now = Date.now();
		if (now - lastRetryableWarning >= RETRYABLE_WARN_INTERVAL_MS) {
			lastRetryableWarning = now;
			logger.warn?.(`[agent-memory] ${route} answered 503 for a retryable failure`, error);
		}
		return memoryError('Temporarily unavailable; retry shortly', 503, 'unavailable');
	}
	logger.error?.(`[agent-memory] ${route} failed`, error);
	return memoryError('Internal error', 500, 'internal_error');
}

function errorResponse(error: unknown, route: string): Response {
	const safe = normalizeError(error, route);
	const body: Record<string, unknown> = { error: safe.message, code: safe.code };
	if (safe.index !== undefined) body.index = safe.index;
	return json(body, safe.statusCode);
}

async function prepareContext(
	context: object | undefined,
): Promise<{ principal: Principal; ctx: Record<string, unknown> }> {
	const ctx = (context ?? {}) as Record<string, unknown>;
	// Static verb overrides replace Resource's transactional() wrapper, which otherwise consumes
	// the HTTP entry `request.authorize` flag before any internal table read runs in this async scope.
	ctx.authorize = false;
	const principal = await resolvePrincipal(ctx);
	return { principal, ctx };
}

async function handle(
	route: string,
	context: object | undefined,
	fn: (principal: Principal, ctx: object) => Promise<Response>,
): Promise<Response> {
	try {
		const { principal, ctx } = await prepareContext(context);
		return await fn(principal, ctx);
	} catch (error) {
		return errorResponse(error, route);
	}
}

async function handleSubscribe<T>(
	context: object | undefined,
	fn: (principal: Principal, ctx: object) => Promise<T>,
): Promise<T> {
	try {
		const { principal, ctx } = await prepareContext(context);
		return await fn(principal, ctx);
	} catch (error) {
		throw normalizeError(error, 'subscribe');
	}
}

function drainIncomingMessages(incomingMessages: any): void {
	if (!incomingMessages) return;
	if (typeof incomingMessages.on === 'function') {
		incomingMessages.on('data', () => {});
		incomingMessages.on('error', () => {});
		return;
	}
	if (typeof incomingMessages[Symbol.asyncIterator] === 'function') {
		void (async () => {
			try {
				for await (const _ of incomingMessages) {
					// Subscription streams are server-to-client only; ignore client frames.
				}
			} catch {
				// Ignore disconnect errors on the incoming side.
			}
		})();
	}
}

// Node's http.ServerResponse defers transmitting headers after writeHead() until the first body byte or
// an explicit flushHeaders() call; an SSE stream yields nothing until a memory event fires, so flush
// once the HTTP adapter has written the 200 status and headers.
function scheduleFlushHeaders(context: any): void {
	const nodeRes = context?._nodeResponse;
	if (typeof nodeRes?.flushHeaders !== 'function') return;
	const attempt = (remaining: number) => {
		setImmediate(() => {
			try {
				if (nodeRes.writableEnded || nodeRes.destroyed) return;
				if (nodeRes.headersSent) {
					nodeRes.flushHeaders();
				} else if (remaining > 0) {
					attempt(remaining - 1);
				}
			} catch {
				// Ignore if the client disconnected before headers flushed.
			}
		});
	};
	attempt(5);
}

const MEMORY_ACTIONS = ['pin', 'unpin', 'confirm'];

function rejectUnsupportedVerb(target: any): never {
	if (target?.rest || target?.pathname) throw notFound();
	if (target?.action !== undefined && !MEMORY_ACTIONS.includes(target.action)) throw notFound();
	throw memoryError('Method not allowed', 405, 'method_not_allowed');
}

// @ts-expect-error — Resource's static verb types carry transactional()'s reliesOnPrototype brand
class MemoryEndpoint extends Resource {
	// Kept out of MCP and OpenAPI auto-export unless explicitly enabled on MemoryResource.
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

	static async subscribe(target: any, context: object): Promise<any> {
		return handleSubscribe(context, async () => rejectUnsupportedVerb(target));
	}

	static async connect(target: any, incomingMessages: any, context: object): Promise<any> {
		// SSE calls connect(target, null, request) and accepts a Response on error; WebSocket passes incomingMessages
		// and translates thrown statusCode errors into close frames.
		if (incomingMessages == null) {
			try {
				const stream = await this.subscribe(target, context);
				scheduleFlushHeaders(context);
				return stream;
			} catch (error) {
				return errorResponse(error, 'connect');
			}
		}
		drainIncomingMessages(incomingMessages);
		try {
			return await this.subscribe(target, context);
		} catch (error) {
			throw normalizeError(error, 'connect');
		}
	}
}

export class MemoryResource extends MemoryEndpoint {
	static path = '/Memory/*rest';

	static override get hidden(): boolean {
		return !getSettings().mcp;
	}

	static get mcpTools() {
		return getSettings().mcp ? MEMORY_MCP_TOOLS : [];
	}

	static get mcpResources() {
		return getSettings().mcp ? MEMORY_MCP_RESOURCES : [];
	}

	static async get(target: any, context: object) {
		return handle('get', context, async (principal, ctx) => {
			if (target?.rest) throw notFound();
			return json({ memories: await searchMemories(parseSearchParams(target), principal, ctx) });
		});
	}

	static override async subscribe(target: any, context: object) {
		return handleSubscribe(context, (principal, ctx) => subscribeMemory(target, principal, ctx));
	}
}

Object.assign(MemoryResource.prototype, MEMORY_MCP_METHODS);

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

export class MemoryWatchResource extends MemoryEndpoint {
	static path = '/Memory/watch';

	static async post(target: any, data: any, context: object) {
		return handle('post', context, async (principal, ctx) => {
			if (target?.pathname) throw notFound();
			return json(await watchMemories(await readBody(data), principal, ctx));
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

	static override async subscribe(target: any, context: object) {
		return handleSubscribe(context, (principal, ctx) => subscribeMemory(target, principal, ctx));
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

export class MemoryEventsResource extends MemoryEndpoint {
	static path = '/MemoryEvents';

	static override async subscribe(target: any, context: object) {
		return handleSubscribe(context, (principal, ctx) => subscribeMemoryEvents(target, principal, ctx));
	}
}

export const MEMORY_RESOURCES = [
	MemoryResource,
	MemoryBootstrapResource,
	MemoryImportResource,
	MemoryWatchResource,
	MemoryItemResource,
	MemoryActionResource,
	MemoryEventsResource,
] as const;
