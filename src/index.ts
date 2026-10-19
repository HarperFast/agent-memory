import type { Scope } from 'harper';
import { MEMORY_RESOURCES, MemoryMcpResource } from './resource.ts';
import { applySettings, parseSettings } from './settings.ts';

export { registerMemorySink, type MemorySink } from './sinks.ts';
export { setPrincipalResolver, type PrincipalResolver, type PrincipalResolution } from './principal.ts';

function routePathFor(basePath: string, resource: { path: string }): string {
	return resource.path.replace(/^\/Memory(?=\/|$|(?:Events|Mcp)\b)/, basePath);
}

export async function handleApplication(scope: Scope): Promise<void> {
	const resources = scope.resources;
	if (!resources) throw new Error('@harperfast/agent-memory: scope.resources is unavailable');
	let mountedPath: string | undefined;
	let mountedMcp = false;

	// Validates before publishing anything, so a rejected reload leaves the previous configuration serving.
	const configure = () => {
		const settings = parseSettings((scope.options.getAll() ?? {}) as Record<string, any>);
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
	};

	configure();
	scope.options.on('change', () => {
		try {
			configure();
		} catch (error) {
			scope.logger.error?.('@harperfast/agent-memory: configuration change rejected; keeping the previous one', error);
		}
	});
}
