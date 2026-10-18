import {
	clearStopFile,
	drainFollowerEvents,
	gcStaleSessions,
	loadBootstrapCache,
	loadSessionState,
	purgeBootstrapCache,
	recordMemoriesInState,
	saveBootstrapCache,
	saveSessionState,
	writeStopFile,
} from './cache.mjs';
import { QUERY_MAX_CHARS, resolveConfig } from './config.mjs';
import { ensureFollowerRunning } from './follower.mjs';
import { formatInjectionBlock, isNeedsReview, resolveAuthorPrincipal } from './format.mjs';

const VALID_BOOTSTRAP_SOURCES = new Set(['startup', 'resume', 'compact']);
const NOTICE_EVENT_KINDS = new Set(['superseded', 'revised', 'withdrawn', 'flagged']);

export function truncatePrompt(prompt) {
	const text = String(prompt ?? '').trim();
	if (text.length <= QUERY_MAX_CHARS) return text;
	return text.slice(0, QUERY_MAX_CHARS);
}

export function buildChangeNotices(state, drainedEvents, recalledMemories = []) {
	const notices = [];
	const injectedSet = new Set(state.injectedIds);
	const watchedSet = new Set(state.watchedIds);
	const seenInBatch = new Set();
	let dirty = false;

	const emitNotice = ({ id, kind, revision, author, scopes, needsReview, supersededBy, ownFlagged, title }) => {
		const revNum = typeof revision === 'number' ? revision : 1;
		const dedupKey = `${id}:${kind}:${revNum}`;
		if (seenInBatch.has(dedupKey)) return;
		const lastNotified = state.notifiedRevisions[id];
		if (lastNotified && lastNotified.revision >= revNum && lastNotified.kind === kind) {
			return;
		}
		seenInBatch.add(dedupKey);
		state.notifiedRevisions[id] = { revision: revNum, kind };
		dirty = true;

		const label = title ? `"${title}" (${id})` : id;
		const targetPrefix = ownFlagged ? `Your memory ${label}` : `Watched memory ${label}`;
		let summary;
		if (kind === 'flagged') {
			summary = `${targetPrefix} was flagged needsReview (revision ${revNum}).`;
		} else if (kind === 'superseded') {
			summary = supersededBy
				? `${targetPrefix} was superseded by ${supersededBy} (revision ${revNum}).`
				: `${targetPrefix} was superseded (revision ${revNum}).`;
		} else if (kind === 'withdrawn') {
			summary = `${targetPrefix} was withdrawn (revision ${revNum}).`;
		} else {
			summary = `${targetPrefix} was ${kind} (revision ${revNum}).`;
		}

		notices.push({
			id,
			kind,
			revision: revNum,
			author,
			scopes,
			needsReview: Boolean(needsReview || kind === 'flagged'),
			supersededBy,
			ownFlagged: Boolean(ownFlagged),
			summary,
		});
	};

	for (const event of drainedEvents) {
		if (!event || typeof event.id !== 'string' || !NOTICE_EVENT_KINDS.has(event.kind)) continue;
		const prev = state.revisions[event.id];
		const isInjectedOrWatched = injectedSet.has(event.id) || watchedSet.has(event.id);
		const isOwnFlagged =
			event.kind === 'flagged' && (!isInjectedOrWatched || (state.ownerId && prev?.author === state.ownerId));
		if (!injectedSet.has(event.id) && event.kind !== 'flagged') {
			continue;
		}
		const revNum = typeof event.revision === 'number' ? event.revision : (prev?.revision ?? 1);
		const author = prev?.author ?? state.ownerId ?? 'self';
		const scopes =
			Array.isArray(prev?.scopes) && prev.scopes.length > 0
				? prev.scopes
				: state.ownerId
					? [`user:${state.ownerId}`]
					: ['user:self'];
		const needsReview = event.kind === 'flagged' ? true : Boolean(prev?.needsReview);

		emitNotice({
			id: event.id,
			kind: event.kind,
			revision: revNum,
			author,
			scopes,
			needsReview,
			ownFlagged: isOwnFlagged,
			title: prev?.title,
		});

		if (prev) {
			prev.revision = Math.max(prev.revision ?? 1, revNum);
			if (event.kind === 'withdrawn' || event.kind === 'superseded') {
				prev.status = event.kind;
			}
			if (event.kind === 'flagged') {
				prev.needsReview = true;
			}
			dirty = true;
		}
	}

	for (const memory of recalledMemories) {
		if (!memory || typeof memory.id !== 'string') continue;
		const prev = state.revisions[memory.id];
		const author = resolveAuthorPrincipal(memory);
		const scopes = Array.isArray(memory.scopes) ? memory.scopes.map(String) : (prev?.scopes ?? []);
		const revNum = typeof memory.revision === 'number' ? memory.revision : 1;
		const flagged = isNeedsReview(memory);
		const isOwn = Boolean(state.ownerId && (memory.ownerId === state.ownerId || author === state.ownerId));

		if (prev && injectedSet.has(memory.id)) {
			let kind;
			if (memory.status === 'superseded' && prev.status !== 'superseded') {
				kind = 'superseded';
			} else if (memory.status === 'withdrawn' && prev.status !== 'withdrawn') {
				kind = 'withdrawn';
			} else if (flagged && !prev.needsReview) {
				kind = 'flagged';
			} else if (revNum > (prev.revision ?? 1)) {
				kind = 'revised';
			}
			if (kind) {
				emitNotice({
					id: memory.id,
					kind,
					revision: revNum,
					author,
					scopes,
					needsReview: flagged,
					supersededBy: memory.supersededBy,
					ownFlagged: kind === 'flagged' && isOwn,
					title: memory.title ?? prev.title,
				});
				prev.revision = revNum;
				prev.status = memory.status ?? prev.status;
				prev.needsReview = flagged;
				dirty = true;
			}
		} else if (isOwn && flagged) {
			emitNotice({
				id: memory.id,
				kind: 'flagged',
				revision: revNum,
				author,
				scopes,
				needsReview: true,
				ownFlagged: true,
				title: memory.title,
			});
		}
	}

	return { notices, dirty };
}

export async function handleSessionStart(input = {}, options = {}) {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	if (!config.configured) return {};

	const source = input.source ? String(input.source) : 'startup';
	if (!VALID_BOOTSTRAP_SOURCES.has(source)) return {};

	const sessionId = String(input.session_id || 'default');
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	gcStaleSessions(config);
	clearStopFile(config, sessionId);

	const state = loadSessionState(config, sessionId);
	if (source === 'startup' || state.corrupt) {
		state.injectedIds = [];
		state.watchedIds = [];
		state.revisions = {};
		state.notifiedRevisions = {};
		state.corrupt = false;
	} else if (source === 'compact') {
		state.injectedIds = [];
		state.corrupt = false;
	}

	const banners = [];
	if (config.urlFromEnvFile) {
		banners.push(
			'AGENT_MEMORY_URL was loaded from ~/.config/agent-memory/env; also export AGENT_MEMORY_URL in your shell or Claude Code settings so .mcp.json can expand ${AGENT_MEMORY_URL}/mcp.',
		);
	}
	if (config.envFileInsecurePermissions) {
		banners.push('~/.config/agent-memory/env is group- or world-readable; run chmod 600 ~/.config/agent-memory/env.');
	}

	const url = `${config.baseUrl}/Memory/bootstrap?budget=${encodeURIComponent(config.bootstrapBudget)}&watch=true`;
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: config.authorization,
			},
			redirect: 'error',
			signal: AbortSignal.timeout(config.bootstrapTimeoutMs),
		});
	} catch {
		response = undefined;
	}

	if (response && (response.status === 401 || response.status === 403)) {
		purgeBootstrapCache(config);
		const formatted = formatInjectionBlock({
			banners: [`agent-memory authentication failed (HTTP ${response.status}); cached bootstrap data cleared.`],
			budget: config.bootstrapBudget,
			nonce: options.nonce,
		});
		if (!formatted.text) return {};
		return {
			hookSpecificOutput: {
				hookEventName: 'SessionStart',
				additionalContext: formatted.text,
			},
		};
	}

	if (response && response.ok) {
		let body;
		try {
			body = await response.json();
		} catch {
			body = undefined;
		}
		if (body && Array.isArray(body.memories)) {
			const memories = body.memories;
			const formatted = formatInjectionBlock({
				memories,
				banners,
				budget: config.bootstrapBudget,
				nonce: options.nonce,
			});
			recordMemoriesInState(state, memories, formatted.includedMemories);
			saveSessionState(config, sessionId, state);
			saveBootstrapCache(config, memories);
			if (options.spawnFollower !== false) {
				ensureFollowerRunning(config, sessionId, env);
			}
			if (!formatted.text) return {};
			return {
				hookSpecificOutput: {
					hookEventName: 'SessionStart',
					additionalContext: formatted.text,
				},
			};
		}
	}

	const cached = loadBootstrapCache(config);
	if (!cached || cached.memories.length === 0) {
		return {};
	}
	const staleBanner = `STALE CACHE — agent-memory server unreachable; showing cached bootstrap and pinned memories from ${cached.fetchedAt}.`;
	const formatted = formatInjectionBlock({
		memories: cached.memories,
		banners: [staleBanner, ...banners],
		budget: config.bootstrapBudget,
		nonce: options.nonce,
	});
	recordMemoriesInState(state, cached.memories, formatted.includedMemories);
	saveSessionState(config, sessionId, state);
	if (!formatted.text) return {};
	return {
		hookSpecificOutput: {
			hookEventName: 'SessionStart',
			additionalContext: formatted.text,
		},
	};
}

export async function handleUserPromptSubmit(input = {}, options = {}) {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	if (!config.configured || !config.recallEnabled) return {};

	const sessionId = String(input.session_id || 'default');
	const rawPrompt = input.prompt ?? input.user_prompt ?? '';
	const query = truncatePrompt(rawPrompt);

	const state = loadSessionState(config, sessionId);
	if (state.corrupt) {
		return {};
	}

	const { events: drainedEvents, nextOffset } = drainFollowerEvents(config, sessionId, state.eventsOffset);
	let recalledMemories = [];

	if (query.length > 0) {
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		const url = `${config.baseUrl}/Memory/?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(config.recallLimit)}&watch=true`;
		try {
			const response = await fetchImpl(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					Authorization: config.authorization,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(config.recallTimeoutMs),
			});
			if (response.status === 401 || response.status === 403) {
				purgeBootstrapCache(config);
				return {};
			}
			if (!response.ok) {
				return {};
			}
			const body = await response.json();
			if (Array.isArray(body?.memories)) {
				recalledMemories = body.memories;
			}
		} catch {
			return {};
		}
	}

	let dirty = false;
	if (nextOffset !== state.eventsOffset) {
		state.eventsOffset = nextOffset;
		dirty = true;
	}

	const { notices, dirty: noticesDirty } = buildChangeNotices(state, drainedEvents, recalledMemories);
	if (noticesDirty) dirty = true;

	const injectedSet = new Set(state.injectedIds);
	const uninjectedMemories = recalledMemories.filter(
		(memory) => memory && typeof memory.id === 'string' && !injectedSet.has(memory.id),
	);

	const formatted = formatInjectionBlock({
		memories: uninjectedMemories,
		notices,
		budget: config.recallBudget,
		nonce: options.nonce,
	});

	if (recordMemoriesInState(state, recalledMemories, formatted.includedMemories)) {
		dirty = true;
	}

	if (dirty) {
		saveSessionState(config, sessionId, state);
	}

	if (!formatted.text) return {};
	return {
		hookSpecificOutput: {
			hookEventName: 'UserPromptSubmit',
			additionalContext: formatted.text,
		},
	};
}

export async function handleSessionEnd(input = {}, options = {}) {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	if (!config.configured) return {};
	const sessionId = String(input.session_id || 'default');
	writeStopFile(config, sessionId);
	return {};
}

export async function handleHookEvent(input = {}, options = {}) {
	const eventName = String(input?.hook_event_name ?? '');
	if (eventName === 'SessionStart') {
		return handleSessionStart(input, options);
	}
	if (eventName === 'UserPromptSubmit') {
		return handleUserPromptSubmit(input, options);
	}
	if (eventName === 'SessionEnd') {
		return handleSessionEnd(input, options);
	}
	return {};
}
