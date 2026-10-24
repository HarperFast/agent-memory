import { databases, logger } from 'harper';
import { memoryError } from './errors.ts';
import { createPrincipal, type GrantPatterns, type Principal } from './scopes.ts';

export interface PrincipalResolution {
	id: string;
	grants?: GrantPatterns;
	superUser?: boolean;
	source?: string;
}

/**
 * Maps a request context to a principal. `next()` is the default resolution (the Harper user and its
 * ScopeGrant rows), so a resolver can handle its own credentials and defer everything else. Returning
 * undefined means unauthenticated.
 */
export type PrincipalResolver = (
	context: any,
	next: () => Promise<PrincipalResolution | undefined>,
) => PrincipalResolution | undefined | Promise<PrincipalResolution | undefined>;

let resolver: PrincipalResolver | undefined;

export function setPrincipalResolver(fn: PrincipalResolver | undefined): void {
	resolver = fn;
}

export function hasCustomPrincipalResolver(): boolean {
	return resolver !== undefined;
}

function grantRows(): any {
	return (databases as any).memory.ScopeGrant;
}

async function resolveHarperUser(context: any): Promise<PrincipalResolution | undefined> {
	const user = context?.user;
	if (typeof user?.username !== 'string') return undefined;
	if (user.role?.permission?.super_user === true) return { id: user.username, superUser: true };
	const roleName = user.role?.role;
	// Read on every request rather than cached, so revoking a grant takes effect immediately. Each read gets its own
	// context: without one Harper takes the caller's, checks its user against ScopeGrant while its `authorize` is
	// pending, and clears that flag before the caller's own read.
	const [roleGrant, userGrant] = await Promise.all([
		typeof roleName === 'string' ? grantRows().get(`role:${roleName}`, { authorize: false }) : undefined,
		grantRows().get(`user:${user.username}`, { authorize: false }),
	]);
	return {
		id: user.username,
		grants: {
			read: [...(roleGrant?.read ?? []), ...(userGrant?.read ?? [])],
			write: [...(roleGrant?.write ?? []), ...(userGrant?.write ?? [])],
		},
	};
}

// Grants are compiled on every request; warn once per pattern rather than once per request.
const warnedPatterns = new Set<string>();
const MAX_WARNED_PATTERNS = 1000;

function warnRejectedPattern(pattern: unknown): void {
	const key = JSON.stringify(pattern);
	if (warnedPatterns.has(key) || warnedPatterns.size >= MAX_WARNED_PATTERNS) return;
	warnedPatterns.add(key);
	logger.warn?.(`[agent-memory] ignoring invalid scope grant pattern ${key}`);
}

/**
 * The caller behind a request context: the custom resolver's answer, else the Harper user and its `ScopeGrant`
 * rows. Rejects with a 401 `principal_required` MemoryError when there is no caller; a failed grant read or a
 * throwing resolver rejects with its own error.
 */
export async function resolvePrincipal(context: any): Promise<Principal> {
	const resolution = resolver
		? await resolver(context, () => resolveHarperUser(context))
		: await resolveHarperUser(context);
	if (!resolution) throw memoryError('Authenticated principal required', 401, 'principal_required');
	return createPrincipal(resolution, warnRejectedPattern);
}
