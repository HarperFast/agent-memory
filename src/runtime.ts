import * as harper from 'harper';
import type { BootstrapSection, SearchAnnotator } from './extensions.ts';
import type { PrincipalResolver } from './principal.ts';
import type { Principal } from './scopes.ts';
import type { ScanOptions } from './search.ts';
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
	// Absent from a runtime published by 0.1.4 or earlier, which also never renders sections or runs annotators.
	scanMemories?(options?: ScanOptions): AsyncIterable<Record<string, unknown>>;
}

export interface MemoryDomain {
	readonly sinks: MemorySink[];
	resolver: PrincipalResolver | undefined;
	runtime: MemoryRuntime | undefined;
	// Absent from a domain an older copy created; added on first use.
	bootstrapSections?: BootstrapSection[];
	searchAnnotators?: SearchAnnotator[];
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
let warnedOldRuntime = false;
let checkedRuntime: MemoryRuntime | undefined;

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

// Keyed by the bindings Harper gives each app scope (DESIGN.md, Extension points, Across apps).
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

// A diagnostic must never fail the registration, load or authorization that triggered it.
function warn(message: string): void {
	try {
		harper.logger.warn?.(message);
	} catch {}
}

function warnUnscopedOnce(): void {
	if (warnedUnscoped) return;
	warnedUnscoped = true;
	warn(UNSCOPED_COPY);
}

export function noteRegistration(): void {
	domain();
	if (scoped) return;
	const shared = anchor();
	shared.unscopedRegistration = true;
	if (shared.scopedRuntime) warnUnscopedOnce();
}

/** For a section or annotator registration: an older running plugin never reads them, so say so once. */
export function noteExtensionRegistration(): void {
	noteRegistration();
	const runtime = domain().runtime;
	if (warnedOldRuntime || runtime === undefined || typeof runtime.scanMemories === 'function') return;
	warnedOldRuntime = true;
	warn(
		`@harperfast/agent-memory: the running plugin is ${runtime.version}, which never renders bootstrap sections or runs search annotators; upgrade it to use them`,
	);
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

const OWN_MAJOR = major(PACKAGE_VERSION);

export function foreignRuntime(own: MemoryRuntime): MemoryRuntime | undefined {
	const runtime = domain().runtime;
	if (runtime === undefined || runtime === own) return undefined;
	if (runtime !== checkedRuntime) {
		checkedRuntime = runtime;
		if (major(runtime.version) !== OWN_MAJOR) {
			warn(
				`@harperfast/agent-memory: this app imports ${PACKAGE_VERSION} but the running plugin is ${runtime.version}; calls go to the running plugin`,
			);
		}
	}
	return runtime;
}
