import type { Scope } from 'harper';
import { MEMORY_RESOURCES, MemoryItemResource, MemoryResource } from './resource.ts';
import { applySettings, parseSettings } from './settings.ts';

export { registerMemorySink, type MemorySink } from './sinks.ts';
export { setPrincipalResolver, type PrincipalResolver, type PrincipalResolution } from './principal.ts';

function routePathFor(basePath: string, resource: { path: string }): string {
	return resource.path.replace(/^\/Memory(?=\/|$|Events\b)/, basePath);
}

export async function handleApplication(scope: Scope): Promise<void> {
	const resources = scope.resources;
	if (!resources) throw new Error('@harperfast/agent-memory: scope.resources is unavailable');
	let mountedPath: string | undefined;

	// Validates before publishing anything, so a rejected reload leaves the previous configuration serving.
	const configure = () => {
		const settings = parseSettings((scope.options.getAll() ?? {}) as Record<string, any>);
		applySettings(settings);
		if (settings.urlPath !== mountedPath) {
			for (const ResourceClass of MEMORY_RESOURCES) {
				const routePath = routePathFor(settings.urlPath, ResourceClass);
				resources.set(routePath, ResourceClass);
				if (ResourceClass === MemoryResource || ResourceClass === MemoryItemResource) {
					const route = resources.paramRoutes?.find((r) => r.pattern === routePath);
					if (route?.entry) route.entry.path = settings.urlPath;
				}
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
			mountedPath = settings.urlPath;
		}
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
