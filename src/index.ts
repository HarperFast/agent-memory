import type { Scope } from 'harper';
import { MemoryResource } from './resource.ts';
import { applySettings, parseSettings } from './settings.ts';

export { registerMemorySink, type MemorySink } from './sinks.ts';
export { setPrincipalResolver, type PrincipalResolver, type PrincipalResolution } from './principal.ts';

export async function handleApplication(scope: Scope): Promise<void> {
	const resources = scope.resources;
	if (!resources) throw new Error('@harperfast/agent-memory: scope.resources is unavailable');
	let mountedPath: string | undefined;

	// Validates before publishing anything, so a rejected reload leaves the previous configuration serving.
	const configure = () => {
		const settings = parseSettings((scope.options.getAll() ?? {}) as Record<string, any>);
		if (settings.urlPath !== mountedPath) {
			resources.set(settings.urlPath, MemoryResource);
			if (mountedPath !== undefined && resources.get(mountedPath)?.Resource === MemoryResource) {
				resources.delete(mountedPath);
			}
			mountedPath = settings.urlPath;
		}
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
