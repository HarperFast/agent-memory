import * as harper from 'harper';
import type { PrincipalResolver } from './principal.ts';
import type { Principal } from './scopes.ts';
import type { MemorySink } from './sinks.ts';
import { PACKAGE_VERSION } from './version.ts';

/**
 * What a running plugin publishes for other copies of the package. Shared across package versions, so like the
 * rest of this file's shapes it only gains members; changing one needs a new anchor key.
 */
export interface MemoryRuntime {
	readonly version: string;
	resolvePrincipal(context: any): Promise<Principal>;
	canReadLabels(principal: Principal, labels: readonly string[] | null | undefined): boolean;
}

export interface MemoryDomain {
	readonly sinks: MemorySink[];
	resolver: PrincipalResolver | undefined;
	runtime: MemoryRuntime | undefined;
}

interface Anchor {
	readonly domains: WeakMap<object, WeakMap<object, MemoryDomain>>;
	scopedRuntime?: boolean;
	unscopedRegistration?: boolean;
}

const ANCHOR_KEY = Symbol.for('@harperfast/agent-memory');

const UNSCOPED_COPY =
	"@harperfast/agent-memory: a copy of the package was loaded without its app's scope (applications.dependencyLoader: native?), so sinks and principal resolvers registered through it never reach the running plugin";

let memo: MemoryDomain | undefined;
let scoped = false;
let warnedUnscoped = false;
let warnedVersion = false;

function isObject(value: unknown): value is object {
	return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

// `process` is the one object every Harper module loader hands each app unchanged; `globalThis` differs per app
// under the `vm` and `compartment` loaders.
function anchor(): Anchor {
	const holder = process as unknown as Record<symbol, Anchor | undefined>;
	let shared = holder[ANCHOR_KEY];
	if (shared === undefined) {
		shared = { domains: new WeakMap() };
		Object.defineProperty(process, ANCHOR_KEY, { value: shared });
	}
	return shared;
}

/**
 * The state this copy shares with every other copy loaded into the same `resources` registry and `databases`
 * view: Harper gives all live apps on a worker the same pair, a deploy-validation candidate its own `resources`,
 * and an app with branched databases its own `databases`. A copy loaded without an app scope (its `harper` has
 * no `resources`) keeps a private domain.
 */
export function domain(): MemoryDomain {
	if (memo !== undefined) return memo;
	const { resources, databases } = harper as unknown as { resources?: unknown; databases?: unknown };
	if (!isObject(resources) || !isObject(databases)) {
		memo = { sinks: [], resolver: undefined, runtime: undefined };
		return memo;
	}
	scoped = true;
	const byResources = anchor().domains;
	let byDatabases = byResources.get(resources);
	if (byDatabases === undefined) {
		byDatabases = new WeakMap();
		byResources.set(resources, byDatabases);
	}
	let found = byDatabases.get(databases);
	if (found === undefined) {
		found = { sinks: [], resolver: undefined, runtime: undefined };
		byDatabases.set(databases, found);
	}
	memo = found;
	return found;
}

function warnUnscopedOnce(): void {
	if (warnedUnscoped) return;
	warnedUnscoped = true;
	harper.logger.warn?.(UNSCOPED_COPY);
}

export function noteRegistration(): void {
	domain();
	if (scoped) return;
	const shared = anchor();
	shared.unscopedRegistration = true;
	if (shared.scopedRuntime) warnUnscopedOnce();
}

export function publishRuntime(runtime: MemoryRuntime): void {
	domain().runtime = runtime;
	if (!scoped) return;
	const shared = anchor();
	shared.scopedRuntime = true;
	if (shared.unscopedRegistration) warnUnscopedOnce();
}

function major(version: string): string {
	return version.split('.', 1)[0];
}

/** The running plugin's runtime when it is another copy, else undefined. */
export function foreignRuntime(own: MemoryRuntime): MemoryRuntime | undefined {
	const runtime = domain().runtime;
	if (runtime === undefined || runtime === own) return undefined;
	if (!warnedVersion && major(runtime.version) !== major(PACKAGE_VERSION)) {
		warnedVersion = true;
		harper.logger.warn?.(
			`@harperfast/agent-memory: this app imports ${PACKAGE_VERSION} but the running plugin is ${runtime.version}; calls go to the running plugin`,
		);
	}
	return runtime;
}
