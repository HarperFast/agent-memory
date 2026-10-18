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
	saveSessionState,
} from './cache.mjs';
import { isMainModule, resolveConfig } from './config.mjs';

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

function markFollowerConnected(lockFile, startedAt) {
	try {
		const payload = JSON.stringify({ pid: process.pid, startedAt, connected: true });
		writeFileSync(lockFile, payload, { encoding: 'utf8', mode: 0o600 });
	} catch {
		return;
	}
}

function releaseOwnedLock(lockFile, startedAt) {
	try {
		const parsed = JSON.parse(readFileSync(lockFile, 'utf8'));
		if (parsed && parsed.pid === process.pid && parsed.startedAt === startedAt) {
			unlinkSync(lockFile);
		}
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
		let existingSize = 0;
		try {
			existingSize = statSync(logPath).size;
		} catch {
			existingSize = 0;
		}
		if (existingSize > MAX_ERROR_LOG_BYTES) return;
		appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 });
	} catch {
		return;
	}
}

async function postWatchBatch(config, ids, fetchImpl, signal) {
	return fetchImpl(`${config.baseUrl}/Memory/watch`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: config.authorization,
		},
		body: JSON.stringify({ ids, ttlSeconds: 3600 }),
		redirect: 'error',
		signal,
	});
}

export async function renewSessionWatches(config, sessionId, fetchImpl = globalThis.fetch, signal) {
	const state = loadSessionState(config, sessionId);
	const rawIds = Array.isArray(state.watchedIds) ? state.watchedIds : [];
	if (rawIds.length === 0) return true;

	const staleIds = new Set();
	const activeIds = [];
	for (const id of rawIds) {
		const revStatus = state.revisions?.[id]?.status;
		if (revStatus === 'withdrawn' || revStatus === 'superseded') {
			staleIds.add(id);
		} else {
			activeIds.push(id);
		}
	}

	let allSucceeded = true;
	for (let i = 0; i < activeIds.length; i += 100) {
		const batch = activeIds.slice(i, i + 100);
		try {
			const response = await postWatchBatch(config, batch, fetchImpl, signal);
			if (response.ok) continue;
			if (response.status === 404) {
				if (batch.length === 1) {
					staleIds.add(batch[0]);
					continue;
				}
				for (const singleId of batch) {
					const singleRes = await postWatchBatch(config, [singleId], fetchImpl, signal);
					if (singleRes.status === 404) {
						staleIds.add(singleId);
					} else if (!singleRes.ok) {
						allSucceeded = false;
					}
				}
			} else {
				allSucceeded = false;
			}
		} catch {
			return false;
		}
	}

	if (staleIds.size > 0) {
		const latest = loadSessionState(config, sessionId);
		if (!latest.corrupt && Array.isArray(latest.watchedIds)) {
			const filtered = latest.watchedIds.filter((id) => !staleIds.has(id));
			if (filtered.length !== latest.watchedIds.length) {
				latest.watchedIds = filtered;
				saveSessionState(config, sessionId, latest);
			}
		}
	}

	return allSucceeded;
}

export async function consumeSseStream(body, onEvent, onActivity) {
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
						onActivity?.();
						onEvent(parsed);
					}
				} catch {
					return;
				}
			}
			return;
		}
		if (line.startsWith(':')) {
			onActivity?.();
			return;
		}
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

function waitAbortableDelay(delayMs, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(backoff);
			resolve();
		};
		const backoff = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		backoff.unref?.();
		signal.addEventListener('abort', onAbort, { once: true });
	});
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
	let renewingWatches = false;
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
			const nowSec = now / 1000;
			try {
				utimesSync(lockFile, nowSec, nowSec);
				lastHeartbeat = now;
			} catch {
				return;
			}
		}
		if (!renewingWatches && now - lastWatchRenew >= config.watchRenewMs) {
			renewingWatches = true;
			void renewSessionWatches(config, sessionId, fetchImpl, controller.signal)
				.then((ok) => {
					if (ok) lastWatchRenew = Date.now();
				})
				.finally(() => {
					renewingWatches = false;
				});
		}
	}, checkIntervalMs);
	timer.unref?.();

	let attempt = 0;
	try {
		while (!shouldStop() && !controller.signal.aborted) {
			const streamStart = Date.now();
			let sawActivity = false;
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
				markFollowerConnected(lockFile, startedAt);
				await consumeSseStream(
					response.body,
					(event) => {
						appendFollowerEvent(eventsFile, {
							id: event.id,
							kind: event.kind,
							revision: typeof event.revision === 'number' ? event.revision : 1,
							ts: Date.now(),
						});
					},
					() => {
						sawActivity = true;
						attempt = 0;
					},
				);
				if (controller.signal.aborted || shouldStop()) break;
				if (!sawActivity && Date.now() - streamStart < 1000) {
					attempt += 1;
				} else {
					attempt = 0;
				}
				const delayMs =
					attempt > 0 ? Math.min(5000, 100 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 100) : 200;
				await waitAbortableDelay(delayMs, controller.signal);
			} catch (error) {
				if (controller.signal.aborted || shouldStop()) break;
				attempt += 1;
				logFollowerError(config, `stream error (attempt ${attempt}): ${error?.message ?? error}`);
				const delayMs = Math.min(5000, 100 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 100);
				await waitAbortableDelay(delayMs, controller.signal);
			}
		}
	} finally {
		clearInterval(timer);
		releaseOwnedLock(lockFile, startedAt);
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

if (isMainModule(import.meta.url)) {
	process.on('uncaughtException', () => process.exit(0));
	process.on('unhandledRejection', () => process.exit(0));
	const sessionId = process.argv[2] || 'default';
	const config = resolveConfig(process.env);
	if (config.configured) {
		runFollowerLoop(config, sessionId).finally(() => process.exit(0));
	}
}
