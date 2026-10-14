// The only HTTP surface over the Memory table (routes: DESIGN.md "HTTP surface"). Identity comes from the
// request context only; nothing in the path, query or body contributes to it. Memory ids are 32 hex
// characters, so the `bootstrap` and `import` segments cannot collide with one.
import { logger, Resource } from 'harper';
import { isCallerSafe, notFound } from './errors.ts';
import { importMemories } from './import.ts';
import { createMemory, getMemory, reviseMemory, setMemoryScopes, withdrawMemory } from './lifecycle.ts';
import { resolvePrincipal } from './principal.ts';
import { bootstrapMemories, parseBootstrapParams, parseSearchParams, searchMemories } from './search.ts';

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(error: unknown, route: string): Response {
	if (isCallerSafe(error)) {
		const body: Record<string, unknown> = { error: error.message, code: error.code };
		if (error.index !== undefined) body.index = error.index;
		return json(body, error.statusCode);
	}
	// Harper's 503s (an index rebuilding or lagging, a lock or database briefly unavailable) are retryable; the
	// fixed message keeps their text, which is not vetted for callers, out of the response.
	if ((error as any)?.statusCode === 503) {
		return json({ error: 'Temporarily unavailable; retry shortly', code: 'unavailable' }, 503);
	}
	logger.error?.(`[agent-memory] ${route} failed`, error);
	return json({ error: 'Internal error', code: 'internal_error' }, 500);
}

function segments(target: any): string[] {
	return String(target?.pathname ?? '')
		.split('/')
		.filter(Boolean);
}

export class MemoryResource extends Resource {
	static loadAsInstance = false;
	// Kept out of MCP and OpenAPI auto-export: the generic verbs would not express these routes.
	static hidden = true;

	async get(target: any) {
		const [id, sub] = segments(target);
		try {
			const context = this.getContext() as object;
			const principal = await resolvePrincipal(context);
			if (sub) throw notFound();
			if (!id) return json({ memories: await searchMemories(parseSearchParams(target), principal, context) });
			if (id === 'bootstrap') return json(await bootstrapMemories(parseBootstrapParams(target), principal, context));
			const memory = await getMemory(id, principal, context);
			if (!memory) throw notFound();
			return json({ memory });
		} catch (error) {
			return errorResponse(error, 'get');
		}
	}

	async post(target: any, data: any) {
		const [id, action] = segments(target);
		try {
			const context = this.getContext() as object;
			const principal = await resolvePrincipal(context);
			const input = (await data) ?? {};
			if (!id) {
				const { memory, created } = await createMemory(input, principal, context);
				return json({ memory, created }, created ? 201 : 200);
			}
			if (id === 'import' && !action) return json(await importMemories(input, principal, context));
			switch (action) {
				case 'revise':
					return json({ memory: await reviseMemory(id, input, principal, context) });
				case 'scopes':
					return json({ memory: await setMemoryScopes(id, input, principal, context) });
				case 'withdraw':
					return json({ memory: await withdrawMemory(id, input, principal, context) });
				default:
					throw notFound();
			}
		} catch (error) {
			return errorResponse(error, 'post');
		}
	}
}
