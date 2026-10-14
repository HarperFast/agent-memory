import type { Scope } from 'harper';

export async function handleApplication(scope: Scope): Promise<void> {
	scope.logger.info?.('@harperfast/memory loaded; lifecycle not yet implemented (see DESIGN.md)');
}
