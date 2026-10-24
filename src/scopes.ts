import { badRequest, memoryError } from './errors.ts';

export const GLOBAL_SCOPE = 'global';
const CUSTOMER_NAMESPACE = 'customer';
const SCOPE_LABEL_MAX_CHARS = 128;
// `user:` plus the id must fit a 128-character label.
const PRINCIPAL_ID_MAX_CHARS = 122;
export const MAX_SCOPES_PER_MEMORY = 16;
// Bounds the OR group every search carries.
export const MAX_GRANT_PATTERNS = 256;

const VISIBILITY_PRIVATE = 'private';
const VISIBILITY_SHARED = 'shared';

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

/**
 * `read` and `write` are the effective grant patterns: `user:<id>` first, then exact labels, then namespace
 * wildcards (`customer:*`). A pattern that grants nothing (invalid, in the `user` namespace, past
 * MAX_GRANT_PATTERNS, or inside a granted wildcard) is not listed. A super_user's lists do not enumerate its
 * access; `superUser` does.
 */
export interface Principal {
	readonly id: string;
	readonly superUser: boolean;
	readonly source: string;
	readonly read: readonly string[];
	readonly write: readonly string[];
}

export interface ScopedRecord {
	ownerId?: string;
	scopes?: readonly string[];
	status?: string;
	contentFlag?: unknown;
}

const USER_PREFIX = 'user:';

function userScope(principalId: string): string {
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
		if (exact.size + namespaces.size >= MAX_GRANT_PATTERNS + 1) {
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

function covers(matcher: ScopeMatcher, label: string): boolean {
	return matcher.exact.has(label) || inWildcard(matcher.namespaces, label);
}

// Module-private and non-enumerable, so a JSON, spread or hand-built copy of a principal carries no matcher and
// cannot authorize.
const MATCHER = Symbol('matcher');
const MATCHERS = Symbol('matchers');

interface CompiledList {
	readonly [MATCHER]?: ScopeMatcher;
}

interface CompiledPrincipal {
	readonly [MATCHERS]?: { readonly read: ScopeMatcher; readonly write: ScopeMatcher };
}

function patternList(matcher: ScopeMatcher): readonly string[] {
	const patterns = [...matcher.exact, ...[...matcher.namespaces].map((namespace) => `${namespace}:*`)];
	Object.defineProperty(patterns, MATCHER, { value: matcher });
	return Object.freeze(patterns);
}

function matchersOf(principal: Principal): { readonly read: ScopeMatcher; readonly write: ScopeMatcher } {
	const matchers = (principal as CompiledPrincipal)[MATCHERS];
	if (!matchers) throw new TypeError('Expected a principal returned by resolvePrincipal');
	return matchers;
}

export function matches(patterns: readonly string[], label: string): boolean {
	const matcher = (patterns as CompiledList)[MATCHER];
	if (!matcher) throw new TypeError('Expected the pattern list of a principal returned by resolvePrincipal');
	return covers(matcher, label);
}

export function createPrincipal(input: PrincipalInput, onRejectedPattern?: (pattern: unknown) => void): Principal {
	const id = requirePrincipalId(input.id);
	const read = compileMatcher(input.grants?.read, id);
	const write = compileMatcher(input.grants?.write, id);
	if (onRejectedPattern) for (const pattern of [...read.rejected, ...write.rejected]) onRejectedPattern(pattern);
	const principal = {
		id,
		superUser: input.superUser === true,
		source: input.source || 'harper',
		read: patternList(read.matcher),
		write: patternList(write.matcher),
	};
	Object.defineProperty(principal, MATCHERS, { value: { read: read.matcher, write: write.matcher } });
	return Object.freeze(principal);
}

/** Cleared for customer content: an exact `customer:<org>` grant does not clear, since a flag can name any customer. */
export function readsCustomerContent(principal: Principal): boolean {
	return principal.superUser || matchersOf(principal).read.namespaces.has(CUSTOMER_NAMESPACE);
}

/** Ownership alone never qualifies: an owner can read its own flagged memory without customer clearance. */
export function reviewsCustomerContent(principal: Principal): boolean {
	return (
		readsCustomerContent(principal) &&
		(principal.superUser || matchersOf(principal).write.namespaces.has(CUSTOMER_NAMESPACE))
	);
}

/**
 * Rule 1's label test: any of `labels` matches a read pattern, or the principal is super_user. Ownership,
 * withdrawal and the customer-content quarantine are memory rules that `canRead` adds on top.
 */
export function canReadLabels(principal: Principal, labels: readonly string[]): boolean {
	const { read } = matchersOf(principal);
	return principal.superUser || labels.some((label) => typeof label === 'string' && covers(read, label));
}

export function isCustomerScope(label: string): boolean {
	return label.startsWith(`${CUSTOMER_NAMESPACE}:`);
}

/**
 * Rule 1 of DESIGN.md. Withdrawn memories stay readable to their owner so the tombstone can be inspected; everyone
 * else sees them as gone. A content flag only removes access, never grants it.
 */
export function canRead(record: ScopedRecord, principal: Principal): boolean {
	if (principal.superUser || record.ownerId === principal.id) return true;
	if (record.status === 'withdrawn') return false;
	if (record.contentFlag && !readsCustomerContent(principal)) return false;
	return canReadLabels(principal, record.scopes ?? []);
}

export function canWrite(scopes: readonly string[], principal: Principal): boolean {
	const { write } = matchersOf(principal);
	return principal.superUser || scopes.every((label) => covers(write, label));
}

export function assertWritable(scopes: readonly string[], principal: Principal): void {
	if (!canWrite(scopes, principal)) {
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
 * deduplicated and sorted so a retry with the same set in another order produces an identical array.
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
 * Rule 5: `canRead` as query conditions, pushed into every search lane before its limit. Harper indexes each
 * element of the `scopes` array and matches an array when any element matches. A namespace wildcard is the
 * half-open range [`ns:`, `ns;`) — exactly the labels with that prefix, since `;` follows `:` — because Harper
 * plans `gelt` from the index where it would scan for `starts_with`. Empty for super_user, who reads everything.
 *
 * The quarantine is a second group rather than a branch of the first, so the label group keeps the finite
 * estimate that lets its index drive a narrow principal's search. `not_equal` is true for rows written before
 * `contentFlagged` existed, where `equals null` would drop them (Harper does not index an absent attribute), and
 * Harper evaluates it as a plain filter: a negated `not_equals` would switch to a full index scan on its first miss.
 */
export function readableConditions(principal: Principal): Condition[] {
	if (principal.superUser) return [];
	const { exact, namespaces } = matchersOf(principal).read;
	const owned: Condition = { attribute: 'ownerId', comparator: 'equals', value: principal.id };
	const labels: Condition[] = [owned];
	for (const label of exact) labels.push({ attribute: 'scopes', comparator: 'equals', value: label });
	for (const namespace of namespaces) {
		labels.push({ attribute: 'scopes', comparator: 'gelt', value: [`${namespace}:`, `${namespace};`] });
	}
	if (readsCustomerContent(principal)) return [anyOf(labels)];
	return [anyOf(labels), anyOf([{ attribute: 'contentFlagged', comparator: 'not_equal', value: true }, owned])];
}
