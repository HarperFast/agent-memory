// Resolves `harper` to an in-memory stand-in for unit tests: importing the real package opens RocksDB at
// module load, and parallel `node --test` subprocesses contend for its lock.
import { register } from 'node:module';

const stubUrl = new URL('./harper-stub.mjs', import.meta.url).href;
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'harper') return { url: ${JSON.stringify(stubUrl)}, format: 'module', shortCircuit: true };
	return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
