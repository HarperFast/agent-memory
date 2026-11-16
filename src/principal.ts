import { databases, logger } from 'harper';
import { memoryError } from './errors.ts';
import { domain, noteRegistration } from './runtime.ts';
import { createPrincipal, type GrantPatterns, type Principal } from './scopes.ts';

export interface PrincipalResolution {
	id: string;
	grants?: GrantPatterns;
	superUser?: boolean;
	source?: string;
	actsFor?: string;
}

/**
 * Maps a request context to a principal. `next()` is the default resolution (the Harper user, its ScopeGrant
 * rows and its Delegation row), so a resolver can handle its own credentials and defer everything else.
 * Returning undefined means unauthenticated.
 */
export type PrincipalResolver = (
	context: any,
	next: () => Promise<PrincipalResolution | undefined>,
) => PrincipalResolution | undefined | Promise<PrincipalResolution | undefined>;

export function setPrincipalResolver(fn: PrincipalResolver | undefined): void {
	noteRegistration();
	domain().resolver = fn;
}

export function hasCustomPrincipalResolver(): boolean {
	return domain().resolver !== undefined;
}

function grantRows(): any {
	return (databases as any).memory.ScopeGrant;
}

function delegationRows(): any {
	return (databases as any).memory.Delegation;
}

async function resolveHarperUser(context: any): Promise<PrincipalResolution | undefined> {
	const user = context?.user;
	if (typeof user?.username !== 'string') return undefined;
	if (user.role?.permission?.super_user === true) return { id: user.username, superUser: true };
	const roleName = user.role?.role;
	// Read on every request rather than cached, so revoking a grant takes effect immediately. Each read gets its own
	// context: without one Harper takes the caller's, checks its user against ScopeGrant while its `authorize` is
	// pending, and clears that flag before the caller's own read.
	const [roleGrant, userGrant, delegation] = await Promise.all([
		typeof roleName === 'string' ? grantRows().get(`role:${roleName}`, { authorize: false }) : undefined,
		grantRows().get(`user:${user.username}`, { authorize: false }),
		delegationRows().get(user.username, { authorize: false }),
	]);
	return {
		id: user.username,
		grants: {
			read: [...(roleGrant?.read ?? []), ...(userGrant?.read ?? [])],
			write: [...(roleGrant?.write ?? []), ...(userGrant?.write ?? [])],
		},
		actsFor: delegation?.actsFor,
	};
}

// Grants are compiled on every request; warn once per value rather than once per request.
const warnedValues = new Set<string>();
const MAX_WARNED_VALUES = 1000;

function warnRejected(value: unknown, kind: 'pattern' | 'actsFor'): void {
	const text = JSON.stringify(value);
	const key = `${kind}:${text}`;
	if (warnedValues.has(key) || warnedValues.size >= MAX_WARNED_VALUES) return;
	warnedValues.add(key);
	logger.warn?.(
		kind === 'pattern'
			? `[agent-memory] ignoring invalid scope grant pattern ${text}`
			: `[agent-memory] ignoring invalid delegation actsFor ${text}`,
	);
}

/**
 * The caller behind a request context: the custom resolver's answer, else the Harper user, its `ScopeGrant` rows
 * and its `Delegation` row. Rejects with a 401 `principal_required` MemoryError when there is no caller; a failed
 * grant or delegation read, or a throwing resolver, rejects with its own error.
 */
export async function resolvePrincipal(context: any): Promise<Principal> {
	const resolver = domain().resolver;
	const resolution = resolver
		? await resolver(context, () => resolveHarperUser(context))
		: await resolveHarperUser(context);
	if (!resolution) throw memoryError('Authenticated principal required', 401, 'principal_required');
	return createPrincipal(resolution, warnRejected);
}
