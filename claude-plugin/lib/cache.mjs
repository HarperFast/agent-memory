import { createHash, randomBytes } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
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
	let buf;
	try {
		buf = readFileSync(eventsFile);
	} catch {
		return { events: [], nextOffset: fromOffset };
	}
	if (buf.length <= fromOffset) {
		return { events: [], nextOffset: fromOffset };
	}
	const slice = buf.subarray(fromOffset);
	const lastNewline = slice.lastIndexOf(0x0a);
	if (lastNewline < 0) {
		return { events: [], nextOffset: fromOffset };
	}
	const completeChunk = slice.subarray(0, lastNewline + 1).toString('utf8');
	const nextOffset = fromOffset + lastNewline + 1;
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

export function gcStaleSessions(config, now = Date.now()) {
	const sessionsDir = join(getEndpointCacheDir(config), 'sessions');
	let entries;
	try {
		entries = readdirSync(sessionsDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const fullPath = join(sessionsDir, name);
		try {
			const stat = statSync(fullPath);
			if (now - stat.mtimeMs > config.followerTtlMs) {
				rmSync(fullPath, { force: true });
			}
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
	let existingPinned = [];
	try {
		const prev = JSON.parse(readFileSync(cachePath, 'utf8'));
		if (Array.isArray(prev?.pinned)) existingPinned = prev.pinned;
	} catch {
		existingPinned = [];
	}

	const currentIds = new Set(memories.map((m) => m?.id).filter(Boolean));
	const newPinned = memories.filter((m) => m && m.section === 'pinned');
	const mergedPinned = [
		...newPinned,
		...existingPinned.filter((m) => m && m.id && !currentIds.has(m.id) && m.section === 'pinned'),
	];

	atomicWriteJson(cachePath, {
		fetchedAt: new Date(now).toISOString(),
		fetchedAtMs: now,
		memories,
		pinned: mergedPinned,
	});
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
