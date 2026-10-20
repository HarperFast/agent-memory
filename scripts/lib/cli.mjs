import { realpathSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);

export class UsageError extends Error {}

export function assertSafeUrl(value, name) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new UsageError(`${name} is not a valid URL`);
	}
	if (url.username || url.password) {
		throw new UsageError(`${name} must not embed credentials; pass them through environment variables`);
	}
	const loopback = LOOPBACK_HOSTS.has(url.hostname) || /^127(\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new UsageError(`${name} must use https (plain http is allowed only for loopback hosts)`);
	}
	if (url.search || url.hash) throw new UsageError(`${name} must not carry a query or fragment`);
	return url.origin + url.pathname.replace(/\/+$/, '');
}

export function basicAuth(env, userVar, passVar, defaultUser) {
	const user = env[userVar] || defaultUser;
	const pass = env[passVar];
	if (!user || !pass) {
		throw new UsageError(`set ${defaultUser ? '' : `${userVar} and `}${passVar} in the environment`);
	}
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** A short, content-free code for a failed request: a server's own `code`, or the network error's. */
export function failureCode(value) {
	const candidate = value?.cause?.code ?? value?.code ?? value?.name;
	return typeof candidate === 'string' && ERROR_CODE.test(candidate) ? candidate : 'request_failed';
}

/**
 * Written aside, fsynced and linked into place with mode 0600, so an interrupted write never leaves a truncated
 * file under the final name, and an existing file is never replaced (EEXIST).
 */
export async function publishPrivateFile(path, text) {
	const partial = `${path}.${process.pid}.partial`;
	let handle;
	try {
		handle = await open(partial, 'wx', 0o600);
		await handle.writeFile(text);
		await handle.sync();
		await handle.close();
		handle = null;
		await link(partial, path);
	} finally {
		await handle?.close().catch(() => {});
		await unlink(partial).catch(() => {});
	}
}

export function isEntryPoint(moduleFilename) {
	try {
		return realpathSync(process.argv[1]) === moduleFilename;
	} catch {
		return false;
	}
}
