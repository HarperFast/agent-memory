import { createHash, randomBytes } from 'node:crypto';
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isNeedsReview, resolveAuthorPrincipal } from './format.mjs';

export function getEndpointCacheDir(config) {
	const key = `${config.baseUrl ?? 'default'}\0${config.authorization ?? ''}`;
	const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
	return join(config.cacheDir, hash);
}

export function getSessionPaths(config, sessionId) {
	const safeId = createHash('sha256')
		.update(String(sessionId || 'default'))
		.digest('hex')
		.slice(0, 24);
	const sessionsDir = join(getEndpointCacheDir(config), 'sessions');
	return {
		sessionsDir,
		stateFile: join(sessionsDir, `${safeId}.state.json`),
		eventsFile: join(sessionsDir, `${safeId}.events.jsonl`),
		lockFile: join(sessionsDir, `${safeId}.follower.lock`),
		stopFile: join(sessionsDir, `${safeId}.stop`),
	};
}

function ensureDir(dirPath) {
	mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function atomicWriteJson(filePath, data) {
	const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
	renameSync(tmpPath, filePath);
}

export function createEmptySessionState(sessionId, ownerId) {
	return {
		sessionId: String(sessionId || 'default'),
		ownerId: ownerId ?? undefined,
		injectedIds: [],
		watchedIds: [],
		revisions: {},
		notifiedRevisions: {},
		pendingNotices: [],
		eventsOffset: 0,
		corrupt: false,
	};
}

export function loadSessionState(config, sessionId) {
	const { stateFile } = getSessionPaths(config, sessionId);
	let raw;
	try {
		raw = readFileSync(stateFile, 'utf8');
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return createEmptySessionState(sessionId, config.userId);
		}
		return { ...createEmptySessionState(sessionId, config.userId), corrupt: true };
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ...createEmptySessionState(sessionId, config.userId), corrupt: true };
		}
		return {
			sessionId: String(parsed.sessionId || sessionId || 'default'),
			ownerId: parsed.ownerId ?? config.userId ?? undefined,
			injectedIds: Array.isArray(parsed.injectedIds) ? parsed.injectedIds.map(String) : [],
			watchedIds: Array.isArray(parsed.watchedIds) ? parsed.watchedIds.map(String) : [],
			revisions: parsed.revisions && typeof parsed.revisions === 'object' ? parsed.revisions : {},
			notifiedRevisions:
				parsed.notifiedRevisions && typeof parsed.notifiedRevisions === 'object' ? parsed.notifiedRevisions : {},
			pendingNotices: Array.isArray(parsed.pendingNotices) ? parsed.pendingNotices : [],
			eventsOffset: Number.isInteger(parsed.eventsOffset) && parsed.eventsOffset >= 0 ? parsed.eventsOffset : 0,
			corrupt: Boolean(parsed.corrupt),
		};
	} catch {
		return { ...createEmptySessionState(sessionId, config.userId), corrupt: true };
	}
}

export function saveSessionState(config, sessionId, state) {
	const { sessionsDir, stateFile } = getSessionPaths(config, sessionId);
	ensureDir(sessionsDir);
	atomicWriteJson(stateFile, state);
}

export function recordMemoriesInState(state, memories, injectedMemories = memories) {
	let dirty = false;
	const injectedSet = new Set(state.injectedIds);
	const watchedSet = new Set(state.watchedIds);

	for (const memory of memories) {
		if (!memory || typeof memory.id !== 'string') continue;
		if (!watchedSet.has(memory.id)) {
			watchedSet.add(memory.id);
			state.watchedIds.push(memory.id);
			dirty = true;
		}
		if (!state.ownerId && (memory.section === 'recent' || memory.section === 'needsReview') && memory.ownerId) {
			state.ownerId = String(memory.ownerId);
			dirty = true;
		}
	}

	for (const memory of injectedMemories) {
		if (!memory || typeof memory.id !== 'string') continue;
		if (!injectedSet.has(memory.id)) {
			injectedSet.add(memory.id);
			state.injectedIds.push(memory.id);
			dirty = true;
		}
		const prev = state.revisions[memory.id];
		const nextEntry = {
			revision: typeof memory.revision === 'number' ? memory.revision : 1,
			status: memory.status ?? 'active',
			needsReview: isNeedsReview(memory),
			author: resolveAuthorPrincipal(memory),
			scopes: Array.isArray(memory.scopes) ? memory.scopes.map(String) : [],
			title: typeof memory.title === 'string' ? memory.title : '',
		};
		if (
			!prev ||
			prev.revision !== nextEntry.revision ||
			prev.status !== nextEntry.status ||
			prev.needsReview !== nextEntry.needsReview
		) {
			state.revisions[memory.id] = nextEntry;
			dirty = true;
		}
	}

	return dirty;
}

export function appendFollowerEvent(eventsFile, event) {
	const line = JSON.stringify(event) + '\n';
	appendFileSync(eventsFile, line, { encoding: 'utf8', mode: 0o600 });
}

export function drainFollowerEvents(config, sessionId, fromOffset = 0) {
	const { eventsFile } = getSessionPaths(config, sessionId);
	let fd;
	try {
		fd = openSync(eventsFile, 'r');
	} catch {
		return { events: [], nextOffset: fromOffset };
	}
	try {
		const stat = fstatSync(fd);
		const startOffset = stat.size < fromOffset ? 0 : fromOffset;
		const remaining = stat.size - startOffset;
		if (remaining <= 0) {
			return { events: [], nextOffset: startOffset };
		}
		const slice = Buffer.allocUnsafe(remaining);
		const bytesRead = readSync(fd, slice, 0, remaining, startOffset);
		const validSlice = slice.subarray(0, bytesRead);
		const lastNewline = validSlice.lastIndexOf(0x0a);
		if (lastNewline < 0) {
			return { events: [], nextOffset: startOffset };
		}
		const completeChunk = validSlice.subarray(0, lastNewline + 1).toString('utf8');
		const nextOffset = startOffset + lastNewline + 1;
		const events = [];
		for (const line of completeChunk.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed.id === 'string' && typeof parsed.kind === 'string') {
					events.push(parsed);
				}
			} catch {
				continue;
			}
		}
		return { events, nextOffset };
	} catch {
		return { events: [], nextOffset: fromOffset };
	} finally {
		try {
			closeSync(fd);
		} catch {
			return;
		}
	}
}

export function clearStopFile(config, sessionId) {
	const { stopFile } = getSessionPaths(config, sessionId);
	try {
		unlinkSync(stopFile);
	} catch {
		return;
	}
}

export function writeStopFile(config, sessionId) {
	const { sessionsDir, stopFile } = getSessionPaths(config, sessionId);
	try {
		if (!existsSync(sessionsDir)) return;
		writeFileSync(stopFile, String(Date.now()), { encoding: 'utf8', mode: 0o600 });
	} catch {
		return;
	}
}

function gcSessionsInDir(sessionsDir, config, now) {
	let entries;
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return;
	}
	const bySession = new Map();
	for (const name of entries) {
		const dotIdx = name.indexOf('.');
		if (dotIdx <= 0) continue;
		const prefix = name.slice(0, dotIdx);
		const fullPath = join(sessionsDir, name);
		try {
			const stat = statSync(fullPath);
			const group = bySession.get(prefix) ?? { files: [], maxMtimeMs: 0, lockActive: false };
			group.files.push(fullPath);
			if (stat.mtimeMs > group.maxMtimeMs) {
				group.maxMtimeMs = stat.mtimeMs;
			}
			if (name.endsWith('.follower.lock') && now - stat.mtimeMs <= 3 * config.heartbeatMs) {
				group.lockActive = true;
			}
			bySession.set(prefix, group);
		} catch {
			continue;
		}
	}
	for (const group of bySession.values()) {
		if (group.lockActive) continue;
		if (now - group.maxMtimeMs > config.followerTtlMs) {
			for (const filePath of group.files) {
				try {
					rmSync(filePath, { force: true });
				} catch {
					continue;
				}
			}
		}
	}
}

export function gcStaleSessions(config, now = Date.now()) {
	const currentEndpointDir = getEndpointCacheDir(config);
	gcSessionsInDir(join(currentEndpointDir, 'sessions'), config, now);

	let endpointDirs;
	try {
		endpointDirs = readdirSync(config.cacheDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const dirent of endpointDirs) {
		if (!dirent.isDirectory()) continue;
		const endpointDir = join(config.cacheDir, dirent.name);
		if (endpointDir === currentEndpointDir) continue;
		const subSessionsDir = join(endpointDir, 'sessions');
		gcSessionsInDir(subSessionsDir, config, now);
		try {
			const remainingSessions = existsSync(subSessionsDir) ? readdirSync(subSessionsDir) : [];
			if (remainingSessions.length > 0) continue;
			const cacheFile = join(endpointDir, 'bootstrap-cache.json');
			if (existsSync(cacheFile)) {
				const stat = statSync(cacheFile);
				if (now - stat.mtimeMs <= config.cacheMaxAgeMs) continue;
			}
			rmSync(endpointDir, { recursive: true, force: true });
		} catch {
			continue;
		}
	}
}

export function getBootstrapCachePath(config) {
	return join(getEndpointCacheDir(config), 'bootstrap-cache.json');
}

export function saveBootstrapCache(config, memories, now = Date.now()) {
	const dir = getEndpointCacheDir(config);
	ensureDir(dir);
	const cachePath = getBootstrapCachePath(config);
	const validMemories = (Array.isArray(memories) ? memories : []).filter(
		(m) => m && typeof m.id === 'string' && (!m.status || m.status === 'active'),
	);
	const pinned = validMemories.filter((m) => m.section === 'pinned' || m.pinned === true);

	atomicWriteJson(cachePath, {
		fetchedAt: new Date(now).toISOString(),
		fetchedAtMs: now,
		memories: validMemories,
		pinned,
	});
}

export function evictFromBootstrapCache(config, ids) {
	if (!Array.isArray(ids) || ids.length === 0) return;
	const cachePath = getBootstrapCachePath(config);
	try {
		if (!existsSync(cachePath)) return;
		const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
		if (!parsed || typeof parsed !== 'object') return;
		const evictSet = new Set(ids);
		const nextMemories = Array.isArray(parsed.memories) ? parsed.memories.filter((m) => m && !evictSet.has(m.id)) : [];
		const nextPinned = Array.isArray(parsed.pinned) ? parsed.pinned.filter((m) => m && !evictSet.has(m.id)) : [];
		atomicWriteJson(cachePath, {
			...parsed,
			memories: nextMemories,
			pinned: nextPinned,
		});
	} catch {
		return;
	}
}

export function loadBootstrapCache(config, now = Date.now()) {
	const cachePath = getBootstrapCachePath(config);
	try {
		const raw = readFileSync(cachePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return undefined;
		const fetchedAtMs =
			typeof parsed.fetchedAtMs === 'number' ? parsed.fetchedAtMs : Date.parse(parsed.fetchedAt ?? '');
		if (Number.isFinite(fetchedAtMs) && now - fetchedAtMs > config.cacheMaxAgeMs) {
			return undefined;
		}
		const bootstrapMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
		const pinnedMemories = Array.isArray(parsed.pinned) ? parsed.pinned : [];
		const seen = new Set();
		const combined = [];
		for (const m of [...pinnedMemories, ...bootstrapMemories]) {
			if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
			seen.add(m.id);
			combined.push(m);
		}
		return {
			fetchedAt: parsed.fetchedAt ?? new Date(fetchedAtMs || now).toISOString(),
			memories: combined,
		};
	} catch {
		return undefined;
	}
}

export function purgeBootstrapCache(config) {
	const cachePath = getBootstrapCachePath(config);
	try {
		rmSync(cachePath, { force: true });
	} catch {
		return;
	}
}
