import { badRequest, memoryError } from './errors.ts';

export const GLOBAL_SCOPE = 'global';
export const SCOPE_LABEL_MAX_CHARS = 128;
// `user:` plus the id must fit a 128-character label.
export const PRINCIPAL_ID_MAX_CHARS = 122;
export const MAX_SCOPES_PER_MEMORY = 16;
// Bounds the OR group every search carries.
export const MAX_GRANT_PATTERNS = 256;

export const VISIBILITY_PRIVATE = 'private';
export const VISIBILITY_SHARED = 'shared';

// `:` would let an id forge a different label (`user:a:b`), `*` would turn it into a wildcard.
const PRINCIPAL_ID_FORBIDDEN = /[\s:*]/;
const LABEL_PATTERN = /^[^\s:*]+:[^\s*]+$/;
const WILDCARD_PATTERN = /^([^\s:*]+):\*$/;

export interface GrantPatterns {
	read?: readonly unknown[];
	write?: readonly unknown[];
}

export interface PrincipalInput {
	id: unknown;
	superUser?: boolean;
	source?: string;
	grants?: GrantPatterns;
}

export interface ScopeMatcher {
	readonly exact: ReadonlySet<string>;
	readonly namespaces: ReadonlySet<string>;
}

export interface Principal {
	readonly id: string;
	readonly superUser: boolean;
	readonly source: string;
	readonly read: ScopeMatcher;
	readonly write: ScopeMatcher;
}

export interface ScopedRecord {
	ownerId?: string;
	scopes?: readonly string[];
	status?: string;
}

const USER_PREFIX = 'user:';

export function userScope(principalId: string): string {
	return `${USER_PREFIX}${principalId}`;
}

export function isScopeLabel(label: unknown): label is string {
	return (
		typeof label === 'string' &&
		label.length <= SCOPE_LABEL_MAX_CHARS &&
		(label === GLOBAL_SCOPE || LABEL_PATTERN.test(label))
	);
}

export function requirePrincipalId(id: unknown): string {
	if (typeof id !== 'string' || id.length === 0) {
		throw memoryError('Authenticated principal required', 401, 'principal_required');
	}
	if (id.length > PRINCIPAL_ID_MAX_CHARS) {
		throw badRequest(`Principal id exceeds ${PRINCIPAL_ID_MAX_CHARS} characters`, 'principal_too_long');
	}
	if (PRINCIPAL_ID_FORBIDDEN.test(id)) {
		throw badRequest('Principal id must not contain whitespace, ":" or "*"', 'invalid_principal_id');
	}
	return id;
}

/**
 * Compile grant patterns into a matcher. `user:<self>` is always included. A pattern that is neither an exact
 * label nor `<namespace>:*` is reported in `rejected` and grants nothing; patterns past MAX_GRANT_PATTERNS too.
 * So is any pattern in the `user` namespace: `user:<id>` means the owner only, and a grant such as `user:*`
 * would quietly open every private memory. Reading everything is what super_user is for.
 */
export function compileMatcher(
	patterns: readonly unknown[] | undefined,
	principalId: string,
): { matcher: ScopeMatcher; rejected: unknown[] } {
	const exact = new Set<string>([userScope(principalId)]);
	const namespaces = new Set<string>();
	const rejected: unknown[] = [];
	for (const pattern of patterns ?? []) {
		if (exact.size + namespaces.size >= MAX_GRANT_PATTERNS) {
			rejected.push(pattern);
			continue;
		}
		const wildcard = typeof pattern === 'string' ? WILDCARD_PATTERN.exec(pattern) : null;
		if (typeof pattern === 'string' && pattern.startsWith(USER_PREFIX)) rejected.push(pattern);
		else if (wildcard) namespaces.add(wildcard[1]);
		else if (isScopeLabel(pattern)) exact.add(pattern);
		else rejected.push(pattern);
	}
	for (const label of exact) {
		if (inWildcard(namespaces, label)) exact.delete(label);
	}
	return { matcher: { exact, namespaces }, rejected };
}

// `global` has no namespace, so no wildcard covers it.
function inWildcard(namespaces: ReadonlySet<string>, label: string): boolean {
	const colon = label.indexOf(':');
	return colon !== -1 && namespaces.has(label.slice(0, colon));
}

export function matches(matcher: ScopeMatcher, label: string): boolean {
	return matcher.exact.has(label) || inWildcard(matcher.namespaces, label);
}

export function createPrincipal(input: PrincipalInput, onRejectedPattern?: (pattern: unknown) => void): Principal {
	const id = requirePrincipalId(input.id);
	const read = compileMatcher(input.grants?.read, id);
	const write = compileMatcher(input.grants?.write, id);
	if (onRejectedPattern) for (const pattern of [...read.rejected, ...write.rejected]) onRejectedPattern(pattern);
	return Object.freeze({
		id,
		superUser: input.superUser === true,
		source: input.source || 'harper',
		read: read.matcher,
		write: write.matcher,
	});
}

/** Rule 1 of DESIGN.md. A withdrawn memory stays readable by its owner so it can be inspected and re-created. */
export function canRead(record: ScopedRecord, principal: Principal): boolean {
	if (principal.superUser || record.ownerId === principal.id) return true;
	if (record.status === 'withdrawn') return false;
	return (record.scopes ?? []).some((label) => matches(principal.read, label));
}

export function assertWritable(scopes: readonly string[], principal: Principal): void {
	if (principal.superUser) return;
	if (!scopes.every((label) => matches(principal.write, label))) {
		throw memoryError(
			'Principal is not permitted to write one or more of these scope labels',
			403,
			'scope_not_writable',
		);
	}
}

/** Supersede: every reader of the old memory (by label) must be able to read its replacement. */
export function isSuperset(next: readonly string[], previous: readonly string[]): boolean {
	return previous.every((label) => next.includes(label));
}

/**
 * The scopes a write produces: explicit `scopes` wins over `visibility`; neither means private. Labels are
 * deduplicated and sorted so a retry with the same set in another order has the same fingerprint.
 */
export function normalizeScopes(scopes: unknown, visibility: unknown, principalId: string): string[] {
	if (scopes !== undefined && scopes !== null) {
		if (!Array.isArray(scopes) || scopes.length === 0) {
			throw badRequest('scopes must be a non-empty array of scope labels', 'invalid_scopes');
		}
		if (!scopes.every(isScopeLabel)) {
			throw badRequest(
				`scope labels must be "global" or "namespace:value", at most ${SCOPE_LABEL_MAX_CHARS} characters, without "*" or whitespace`,
				'invalid_scope_label',
			);
		}
		const unique = [...new Set(scopes)].sort();
		if (unique.length > MAX_SCOPES_PER_MEMORY) {
			throw badRequest(`A memory carries at most ${MAX_SCOPES_PER_MEMORY} scope labels`, 'too_many_scopes');
		}
		return unique;
	}
	if (visibility === undefined || visibility === null || visibility === VISIBILITY_PRIVATE) {
		return [userScope(principalId)];
	}
	if (visibility === VISIBILITY_SHARED) return [GLOBAL_SCOPE];
	throw badRequest(`visibility must be one of: ${VISIBILITY_PRIVATE}, ${VISIBILITY_SHARED}`, 'invalid_visibility');
}

export interface Condition {
	attribute?: string;
	comparator?: string;
	value?: unknown;
	operator?: 'and' | 'or';
	conditions?: Condition[];
}

/** Harper rejects an `or` group with fewer than two conditions. */
export function anyOf(conditions: Condition[]): Condition {
	return conditions.length === 1 ? conditions[0] : { operator: 'or', conditions };
}

/**
 * Rule 5: the readable set as one query condition, pushed into every search lane before its limit. Harper
 * indexes each element of the `scopes` array and matches an array when any element matches. A namespace
 * wildcard is the half-open range [`ns:`, `ns;`) — exactly the labels with that prefix, since `;` follows `:`
 * — because Harper plans `gelt` from the index where it would scan for `starts_with`. Undefined for
 * super_user, who reads everything.
 */
export function readableCondition(principal: Principal): Condition | undefined {
	if (principal.superUser) return undefined;
	const conditions: Condition[] = [{ attribute: 'ownerId', comparator: 'equals', value: principal.id }];
	for (const label of principal.read.exact)
		conditions.push({ attribute: 'scopes', comparator: 'equals', value: label });
	for (const namespace of principal.read.namespaces) {
		conditions.push({ attribute: 'scopes', comparator: 'gelt', value: [`${namespace}:`, `${namespace};`] });
	}
	return anyOf(conditions);
}
