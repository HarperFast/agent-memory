import { spawn } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	appendFollowerEvent,
	clearStopFile,
	getEndpointCacheDir,
	getSessionPaths,
	loadSessionState,
} from './cache.mjs';
import { resolveConfig } from './config.mjs';

const MAX_ERROR_LOG_BYTES = 64 * 1024;

export function isFollowerLockActive(lockFile, heartbeatMs, now = Date.now()) {
	try {
		const stat = statSync(lockFile);
		return now - stat.mtimeMs <= 3 * heartbeatMs;
	} catch {
		return false;
	}
}

export function tryAcquireFollowerLock(lockFile, heartbeatMs, now = Date.now()) {
	const payload = JSON.stringify({ pid: process.pid, startedAt: now, connected: false });
	try {
		writeFileSync(lockFile, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		return true;
	} catch (error) {
		if (!error || error.code !== 'EEXIST') return false;
	}
	if (isFollowerLockActive(lockFile, heartbeatMs, now)) {
		return false;
	}
	try {
		unlinkSync(lockFile);
		writeFileSync(lockFile, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		return true;
	} catch {
		return false;
	}
}

export function markFollowerConnected(lockFile, startedAt) {
	try {
		const payload = JSON.stringify({ pid: process.pid, startedAt, connected: true });
		writeFileSync(lockFile, payload, { encoding: 'utf8', mode: 0o600 });
	} catch {
		return;
	}
}

export function isFollowerConnected(config, sessionId) {
	const { lockFile } = getSessionPaths(config, sessionId);
	if (!isFollowerLockActive(lockFile, config.heartbeatMs)) return false;
	try {
		const parsed = JSON.parse(readFileSync(lockFile, 'utf8'));
		return Boolean(parsed?.connected);
	} catch {
		return false;
	}
}

function logFollowerError(config, message) {
	try {
		const dir = getEndpointCacheDir(config);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const logPath = join(dir, 'follower-errors.log');
		try {
			const stat = statSync(logPath);
			if (stat.size > MAX_ERROR_LOG_BYTES) return;
		} catch {
			// File does not exist yet.
		}
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 });
	} catch {
		return;
	}
}

export async function renewSessionWatches(config, sessionId, fetchImpl = globalThis.fetch, signal) {
	const state = loadSessionState(config, sessionId);
	const ids = state.watchedIds;
	if (!Array.isArray(ids) || ids.length === 0) return;
	for (let i = 0; i < ids.length; i += 100) {
		const batch = ids.slice(i, i + 100);
		try {
			await fetchImpl(`${config.baseUrl}/Memory/watch`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					Authorization: config.authorization,
				},
				body: JSON.stringify({ ids: batch, ttlSeconds: 3600 }),
				redirect: 'error',
				signal,
			});
		} catch {
			return;
		}
	}
}

export async function consumeSseStream(body, onEvent) {
	const decoder = new TextDecoder();
	let buffer = '';
	let dataLines = [];

	const processLine = (rawLine) => {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line === '') {
			if (dataLines.length > 0) {
				const joined = dataLines.join('\n');
				dataLines = [];
				try {
					const parsed = JSON.parse(joined);
					if (parsed && typeof parsed.id === 'string' && typeof parsed.kind === 'string') {
						onEvent(parsed);
					}
				} catch {
					// Ignore non-JSON SSE frames.
				}
			}
			return;
		}
		if (line.startsWith(':')) return;
		if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).trimStart());
		}
	};

	for await (const chunk of body) {
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		let newlineIdx = buffer.indexOf('\n');
		while (newlineIdx !== -1) {
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);
			processLine(line);
			newlineIdx = buffer.indexOf('\n');
		}
	}
	if (buffer.length > 0) {
		processLine(buffer);
		processLine('');
	}
}

export async function runFollowerLoop(config, sessionId, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const { sessionsDir, eventsFile, lockFile, stopFile } = getSessionPaths(config, sessionId);
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

	const startedAt = Date.now();
	if (!tryAcquireFollowerLock(lockFile, config.heartbeatMs, startedAt)) {
		return;
	}

	const controller = new AbortController();
	let lastHeartbeat = startedAt;
	let lastWatchRenew = startedAt;
	const checkIntervalMs = Math.max(50, Math.min(config.heartbeatMs / 2, 1000));

	const shouldStop = () => existsSync(stopFile) || Date.now() - startedAt >= config.followerTtlMs;

	const timer = setInterval(() => {
		const now = Date.now();
		if (shouldStop()) {
			controller.abort();
			clearInterval(timer);
			return;
		}
		if (now - lastHeartbeat >= config.heartbeatMs) {
			lastHeartbeat = now;
			const nowSec = now / 1000;
			try {
				utimesSync(lockFile, nowSec, nowSec);
			} catch {
				// Ignore lock touch failure.
			}
		}
		if (now - lastWatchRenew >= config.watchRenewMs) {
			lastWatchRenew = now;
			void renewSessionWatches(config, sessionId, fetchImpl, controller.signal);
		}
	}, checkIntervalMs);
	timer.unref?.();

	let attempt = 0;
	try {
		while (!shouldStop() && !controller.signal.aborted) {
			try {
				const response = await fetchImpl(`${config.baseUrl}/MemoryEvents`, {
					method: 'GET',
					headers: {
						Accept: 'text/event-stream',
						Authorization: config.authorization,
					},
					redirect: 'error',
					signal: controller.signal,
				});
				if (response.status === 401 || response.status === 403) {
					logFollowerError(config, `auth failed (${response.status}); stopping follower`);
					break;
				}
				if (!response.ok || !response.body) {
					throw new Error(`unexpected status ${response.status}`);
				}
				attempt = 0;
				markFollowerConnected(lockFile, startedAt);
				await consumeSseStream(response.body, (event) => {
					appendFollowerEvent(eventsFile, {
						id: event.id,
						kind: event.kind,
						revision: typeof event.revision === 'number' ? event.revision : 1,
						ts: Date.now(),
					});
				});
			} catch (error) {
				if (controller.signal.aborted || shouldStop()) break;
				attempt += 1;
				logFollowerError(config, `stream error (attempt ${attempt}): ${error?.message ?? error}`);
				const delayMs = Math.min(5000, 100 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 100);
				await new Promise((resolve) => {
					const backoff = setTimeout(resolve, delayMs);
					backoff.unref?.();
					controller.signal.addEventListener('abort', () => clearTimeout(backoff), { once: true });
				});
			}
		}
	} finally {
		clearInterval(timer);
		try {
			unlinkSync(lockFile);
		} catch {
			// Ignore missing lock.
		}
	}
}

export function ensureFollowerRunning(config, sessionId, env = process.env) {
	clearStopFile(config, sessionId);
	if (!config.followerEnabled || !config.configured) return false;
	const { sessionsDir, lockFile } = getSessionPaths(config, sessionId);
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	if (isFollowerLockActive(lockFile, config.heartbeatMs)) {
		return false;
	}
	const scriptPath = fileURLToPath(import.meta.url);
	try {
		const child = spawn(process.execPath, [scriptPath, String(sessionId || 'default')], {
			detached: true,
			stdio: 'ignore',
			env,
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.on('uncaughtException', () => process.exit(0));
	process.on('unhandledRejection', () => process.exit(0));
	const sessionId = process.argv[2] || 'default';
	const config = resolveConfig(process.env);
	if (config.configured) {
		runFollowerLoop(config, sessionId).finally(() => process.exit(0));
	}
}
