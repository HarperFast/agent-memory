import { getLockScope } from '@harperfast/agent-memory';

const lockScope = getLockScope();
if (lockScope !== 'cluster') {
	throw new Error(`lock-scope guard: needs agent-memory lockScope cluster; it reports ${lockScope}`);
}

export class LockScopeGuard extends Resource {
	static loadAsInstance = false;
	get() {
		return { lockScope: getLockScope() };
	}
}
