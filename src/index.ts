import type { Scope } from 'harper';
import { probeCoreTruncate } from './lifecycle.ts';
import { resolvePrincipal as resolveHere } from './principal.ts';
import { MEMORY_RESOURCES, MemoryMcpResource } from './resource.ts';
import { domain, foreignRuntime, publishRuntime, type MemoryRuntime } from './runtime.ts';
import { canReadLabels as canReadLabelsHere, compiledHere, type Principal } from './scopes.ts';
import { scanMemories as scanHere, type ScanOptions } from './search.ts';
import { applySettings, parseSettings } from './settings.ts';
import { PACKAGE_VERSION } from './version.ts';

export { registerMemorySink, type MemorySink } from './sinks.ts';
export {
	registerBootstrapSection,
	registerSearchAnnotator,
	type BootstrapItem,
	type BootstrapRenderInput,
	type BootstrapSection,
	type BootstrapSectionOutput,
	type SearchAnnotateInput,
	type SearchAnnotations,
	type SearchAnnotator,
} from './extensions.ts';
export type { ScanOptions } from './search.ts';
export { setPrincipalResolver, type PrincipalResolver, type PrincipalResolution } from './principal.ts';
export type { Principal } from './scopes.ts';

const RUNTIME: MemoryRuntime = Object.freeze({
	version: PACKAGE_VERSION,
	resolvePrincipal: resolveHere,
	canReadLabels: canReadLabelsHere,
	scanMemories: scanHere,
});

/**
 * The caller behind a request context: the custom resolver's answer, else the Harper user and its `ScopeGrant`
 * rows. Rejects with a 401 `principal_required` MemoryError when there is no caller; a failed grant read or a
 * throwing resolver rejects with its own error. Resolved by the running plugin, even one in another app; by this
 * copy when none runs beside it (DESIGN.md, Extension points).
 */
export function resolvePrincipal(context: any): Promise<Principal> {
	let runtime: MemoryRuntime | undefined;
	try {
		runtime = foreignRuntime(RUNTIME);
	} catch (error) {
		return Promise.reject(error);
	}
	return runtime ? runtime.resolvePrincipal(context) : resolveHere(context);
}

/**
 * Rule 1's label test: any of `labels` matches a read pattern, or the principal is super_user. Missing labels match
 * nothing. Answered by the copy of the package that resolved `principal`; any other object throws a TypeError.
 */
export function canReadLabels(principal: Principal, labels: readonly string[] | null | undefined): boolean {
	const runtime = foreignRuntime(RUNTIME);
	return runtime && !compiledHere(principal)
		? runtime.canReadLabels(principal, labels)
		: canReadLabelsHere(principal, labels);
}

/**
 * Every memory row as stored, oldest `createdAt` first, then by id: active and unexpired ones, or every row with
 * `includeInactive`. `after` (the last row's `createdAt` and `id`) resumes strictly after that row. For trusted
 * in-process code building derived data: it takes no principal and applies no scope rule. Read by the running
 * plugin, even one in another app (DESIGN.md, Extension points).
 */
export function scanMemories(options?: ScanOptions): AsyncIterable<Record<string, unknown>> {
	const runtime = foreignRuntime(RUNTIME);
	return runtime?.scanMemories ? runtime.scanMemories(options) : scanHere(options);
}

function routePathFor(basePath: string, resource: { path: string }): string {
	return resource.path.replace(/^\/Memory(?=\/|$|(?:Events|Mcp)\b)/, basePath);
}

export async function handleApplication(scope: Scope): Promise<void> {
	const resources = scope.resources;
	if (!resources) throw new Error('@harperfast/agent-memory: scope.resources is unavailable');
	const owner = domain().runtime;
	if (owner !== undefined && owner !== RUNTIME) {
		throw new Error(
			`@harperfast/agent-memory: version ${owner.version} of this plugin already serves these apps; list it in only one app's config.yaml`,
		);
	}
	let mountedPath: string | undefined;
	let mountedMcp = false;
	let warnedCoreTruncate: string | undefined;

	// Validates before publishing anything, so a rejected reload leaves the previous configuration serving.
	const configure = () => {
		const settings = parseSettings((scope.options.getAll() ?? {}) as Record<string, any>, () => scope.secrets);
		const pathChanged = settings.urlPath !== mountedPath;
		if (pathChanged) {
			for (const ResourceClass of MEMORY_RESOURCES) {
				resources.set(routePathFor(settings.urlPath, ResourceClass), ResourceClass);
			}
			if (mountedPath !== undefined) {
				for (const ResourceClass of MEMORY_RESOURCES) {
					const oldPath = routePathFor(mountedPath, ResourceClass);
					const existing =
						resources.get(oldPath) ?? resources.paramRoutes?.find((route) => route.pattern === oldPath)?.entry;
					if (existing === undefined || existing.Resource === ResourceClass) {
						resources.delete(oldPath);
					}
				}
			}
		}

		if (settings.mcp && (!mountedMcp || pathChanged)) {
			resources.set(routePathFor(settings.urlPath, MemoryMcpResource), MemoryMcpResource);
		}
		if (mountedMcp && mountedPath !== undefined && (!settings.mcp || pathChanged)) {
			const oldMcpPath = routePathFor(mountedPath, MemoryMcpResource);
			const existing = resources.get(oldMcpPath);
			if (existing === undefined || existing.Resource === MemoryMcpResource) {
				resources.delete(oldMcpPath);
			}
		}

		mountedPath = settings.urlPath;
		mountedMcp = settings.mcp;
		applySettings(settings);
		if (settings.embeddingTruncate && !probeCoreTruncate() && scope.logger.warn) {
			const fallbackChars = Math.min(settings.embeddingInputChars, settings.embeddingFallbackChars);
			const warning =
				`@harperfast/agent-memory: embeddingTruncate needs Harper 5.4 or later; this Harper ignores it, so ` +
				`embeddingModel "${settings.embeddingModel}" embeds the first ${fallbackChars} characters ` +
				'(limits.embeddingFallbackChars)';
			if (warning !== warnedCoreTruncate) scope.logger.warn(warning);
			warnedCoreTruncate = warning;
		}
	};

	configure();
	// The ownership check, configure() and this publish run with no await between them, so two apps loading
	// concurrently cannot both pass the check.
	if (!scope.isTransientValidation) publishRuntime(RUNTIME);
	scope.options.on('change', () => {
		try {
			configure();
		} catch (error) {
			scope.logger.error?.('@harperfast/agent-memory: configuration change rejected; keeping the previous one', error);
		}
	});
}
