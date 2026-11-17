import {
	clearStopFile,
	drainFollowerEvents,
	evictFromBootstrapCache,
	gcStaleSessions,
	loadBootstrapCache,
	loadSessionState,
	purgeBootstrapCache,
	recordMemoriesInState,
	saveBootstrapCache,
	saveSessionState,
	sessionKey,
	writeStopFile,
} from './cache.mjs';
import { QUERY_MAX_CHARS, resolveConfig } from './config.mjs';
import { errorCode, recordDiagnostic } from './diagnostics.mjs';
import { ensureFollowerRunning } from './follower.mjs';
import { bootstrapRequest, formatInjectionBlock, isNeedsReview, resolveAuthorPrincipal } from './format.mjs';

const VALID_BOOTSTRAP_SOURCES = new Set(['startup', 'resume', 'compact']);
const NOTICE_EVENT_KINDS = new Set(['superseded', 'revised', 'withdrawn', 'flagged']);
const FILLER_TERMS = new Set(
	(
		'about actually again agree agreed ahead alright also always anyway awesome been before being cancel could ' +
		'continue cool correct does doing done exactly fine from going good great have hello here into just keep know ' +
		'lgtm like looks make maybe more much need next nice nope okay only perfect please proceed really retry right ' +
		'same seems should some sorry sounds start still stop sure thank thanks that them then there these they thing ' +
		'think this those very wait want well were what when where which will with would yeah your yours'
	).split(' '),
);
const SHORT_WORD_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNCONFIGURED_REMEDY = {
	invalid_url:
		'AGENT_MEMORY_URL must be https (or http to a loopback host unless AGENT_MEMORY_ALLOW_INSECURE_HTTP=1), with no user:password@ part.',
	invalid_token: 'AGENT_MEMORY_TOKEN must be a single-line token or Basic credential.',
};

export function truncatePrompt(prompt) {
	const text = String(prompt ?? '').trim();
	if (text.length <= QUERY_MAX_CHARS) return text;
	return text.slice(0, QUERY_MAX_CHARS);
}

export function buildRecallQuery(prompt) {
	let fence;
	const text = String(prompt ?? '')
		.slice(0, 32_000)
		.normalize('NFKC')
		.split(/\r\n?|\n/)
		.filter((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (fence) {
				if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) {
					fence = undefined;
				}
				return false;
			}
			if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
				fence = marker[1];
				return false;
			}
			return true;
		})
		.join(' ')
		.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi, ' ');
	const query = (text.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32).join(' ');
	return truncatePrompt(query).replace(/[\uD800-\uDBFF]$/, '');
}

// Search fuses ranks only and the vector lane has no distance cutoff, so a query without a topic term would still
// get its nearest, unrelated memory.
export function hasDistinctiveTerm(query) {
	for (const term of String(query ?? '').split(' ')) {
		if (!/\p{L}/u.test(term) || FILLER_TERMS.has(term.toLowerCase())) continue;
		const length = [...term].length;
		if (length >= 4 || (length >= 2 && SHORT_WORD_SCRIPT.test(term))) return true;
	}
	return false;
}

function persist(entry, write) {
	try {
		write();
	} catch (error) {
		const code = errorCode(error) ?? 'unknown';
		if (!entry.stateError?.split(',').includes(code))
			entry.stateError = entry.stateError ? `${entry.stateError},${code}` : code;
	}
}

function hookOutput(hookEventName, text) {
	if (!text) return {};
	return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

async function recordedHook(config, entry, run) {
	try {
		return await run();
	} catch (error) {
		entry.outcome = 'error';
		entry.reason = 'exception';
		entry.code = errorCode(error);
		return {};
	} finally {
		recordDiagnostic(config, entry);
	}
}

function buildChangeNotices(state, drainedEvents, recalledMemories = []) {
	const notices = [];
	const injectedSet = new Set(state.injectedIds);
	const watchedSet = new Set(state.watchedIds);
	const seenInBatch = new Set();

	for (const pending of Array.isArray(state.pendingNotices) ? state.pendingNotices : []) {
		if (!pending || typeof pending.id !== 'string' || typeof pending.kind !== 'string') continue;
		const revNum = typeof pending.revision === 'number' ? pending.revision : 1;
		const dedupKey = `${pending.id}:${pending.kind}:${revNum}`;
		const lastNotified = state.notifiedRevisions[pending.id];
		if (lastNotified && lastNotified.revision >= revNum && lastNotified.kind === pending.kind) {
			continue;
		}
		seenInBatch.add(dedupKey);
		notices.push(pending);
	}

	const queueNotice = ({ id, kind, revision, author, scopes, needsReview, supersededBy, ownFlagged, title }) => {
		const revNum = typeof revision === 'number' ? revision : 1;
		const dedupKey = `${id}:${kind}:${revNum}`;
		if (seenInBatch.has(dedupKey)) return;
		const lastNotified = state.notifiedRevisions[id];
		if (lastNotified && lastNotified.revision >= revNum && lastNotified.kind === kind) {
			return;
		}
		seenInBatch.add(dedupKey);

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
		const isInjected = injectedSet.has(event.id);
		const isWatchedOnly = !isInjected && watchedSet.has(event.id);
		const isKnownOwn = Boolean(state.ownerId && (prev?.ownerId === state.ownerId || prev?.author === state.ownerId));
		const isOwnFlagged = event.kind === 'flagged' && (isKnownOwn || (!isInjected && !isWatchedOnly));
		if (!isInjected && !isOwnFlagged) {
			continue;
		}
		const revNum = typeof event.revision === 'number' ? event.revision : (prev?.revision ?? 1);
		const author = prev?.author ?? (isOwnFlagged && state.ownerId ? state.ownerId : 'unknown');
		const scopes = Array.isArray(prev?.scopes) ? prev.scopes : [];
		const needsReview = event.kind === 'flagged' ? true : Boolean(prev?.needsReview);

		queueNotice({
			id: event.id,
			kind: event.kind,
			revision: revNum,
			author,
			scopes,
			needsReview,
			ownFlagged: isOwnFlagged,
			title: prev?.title,
		});
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
			if (flagged && !prev.needsReview) {
				kind = 'flagged';
			} else if (revNum > (prev.revision ?? 1)) {
				kind = 'revised';
			}
			if (kind) {
				queueNotice({
					id: memory.id,
					kind,
					revision: revNum,
					author,
					scopes,
					needsReview: flagged,
					ownFlagged: kind === 'flagged' && isOwn,
					title: memory.title ?? prev.title,
				});
			}
		} else if (isOwn && flagged && !prev?.needsReview) {
			queueNotice({
				id: memory.id,
				kind: 'flagged',
				revision: revNum,
				author,
				scopes,
				needsReview: true,
				ownFlagged: true,
				title: memory.title ?? prev?.title,
			});
		}
	}

	return notices;
}

function commitChangeNotices(state, candidateNotices, includedNotices, config) {
	let dirty = false;
	const includedSet = new Set(includedNotices);
	const evictedIds = [];

	for (const notice of includedNotices) {
		state.notifiedRevisions[notice.id] = { revision: notice.revision, kind: notice.kind };
		dirty = true;
		const prev = state.revisions[notice.id];
		if (prev) {
			prev.revision = Math.max(prev.revision ?? 1, notice.revision);
			if (notice.kind === 'withdrawn' || notice.kind === 'superseded') {
				prev.status = notice.kind;
			}
			if (notice.kind === 'flagged' || notice.needsReview) {
				prev.needsReview = true;
			}
		}
		if (notice.kind === 'withdrawn' || notice.kind === 'superseded') {
			evictedIds.push(notice.id);
		}
	}

	if (evictedIds.length > 0) {
		const evictSet = new Set(evictedIds);
		state.watchedIds = state.watchedIds.filter((id) => !evictSet.has(id));
		if (config) {
			evictFromBootstrapCache(config, evictedIds);
		}
		dirty = true;
	}

	const remainingPending = candidateNotices.filter((n) => !includedSet.has(n));
	const prevPendingLen = Array.isArray(state.pendingNotices) ? state.pendingNotices.length : 0;
	if (remainingPending.length !== prevPendingLen || remainingPending.length > 0) {
		state.pendingNotices = remainingPending;
		dirty = true;
	}

	return dirty;
}

export async function handleSessionStart(input = {}, options = {}) {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	const source = input.source ? String(input.source) : 'startup';
	const sessionId = String(input.session_id || 'default');
	const entry = { event: 'bootstrap', session: sessionKey(sessionId) };
	if (!VALID_BOOTSTRAP_SOURCES.has(source)) {
		recordDiagnostic(config, { ...entry, outcome: 'skipped', reason: 'unsupported_source' });
		return {};
	}
	return recordedHook(config, entry, () => bootstrapSession(config, env, source, sessionId, options, entry));
}

async function bootstrapSession(config, env, source, sessionId, options, entry) {
	if (!config.configured) {
		entry.outcome = 'unconfigured';
		entry.reason = config.unconfiguredReason;
		if (!config.partiallyConfigured) return {};
		const notice = `agent-memory is not configured (${config.unconfiguredReason})`;
		const remedy =
			UNCONFIGURED_REMEDY[config.unconfiguredReason] ??
			`Credentials are read from the environment or ${config.envFilePath}; a harness that replaces HOME must pass AGENT_MEMORY_ENV_FILE.`;
		for (const banner of [`${notice}; session bootstrap and per-prompt recall are off. ${remedy}`, `${notice}.`]) {
			const formatted = formatInjectionBlock({
				banners: [banner],
				budget: config.bootstrapBudget,
				nonce: options.nonce,
			});
			if (formatted.text) return hookOutput('SessionStart', formatted.text);
		}
		return {};
	}

	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const shouldSpawnFollower = options.spawnFollower ?? !options.fetchImpl;

	gcStaleSessions(config);
	clearStopFile(config, sessionId);

	const state = loadSessionState(config, sessionId);
	if (source === 'startup' || state.corrupt) {
		state.injectedIds = [];
		state.watchedIds = [];
		state.revisions = {};
		state.notifiedRevisions = {};
		state.pendingNotices = [];
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

	const request = bootstrapRequest(config.bootstrapBudget, banners);
	const url = `${config.baseUrl}/Memory/bootstrap?budget=${request.budget}&entryOverhead=${request.entryOverhead}&sectionItemOverhead=${request.sectionItemOverhead}&watch=true`;
	const signal = AbortSignal.timeout(config.bootstrapTimeoutMs);
	const start = performance.now();
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: config.authorization,
			},
			redirect: 'error',
			signal,
		});
	} catch (error) {
		response = undefined;
		entry.outcome = signal.aborted ? 'timeout' : 'error';
		if (!signal.aborted) {
			entry.reason = 'network';
			entry.code = errorCode(error);
		}
	}
	if (response && !response.ok) entry.outcome = `http_${response.status}`;

	if (response && (response.status === 401 || response.status === 403)) {
		entry.ms = Math.round(performance.now() - start);
		purgeBootstrapCache(config);
		const formatted = formatInjectionBlock({
			banners: [`agent-memory authentication failed (HTTP ${response.status}); cached bootstrap data cleared.`],
			budget: config.bootstrapBudget,
			nonce: options.nonce,
		});
		return hookOutput('SessionStart', formatted.text);
	}

	if (response && response.ok) {
		let body;
		try {
			body = await response.json();
		} catch (error) {
			body = undefined;
			if (signal.aborted) {
				entry.outcome = 'timeout';
			} else {
				entry.outcome = 'error';
				entry.reason = error instanceof SyntaxError ? 'bad_json' : 'network';
				entry.code = errorCode(error);
			}
			// A body cut off by the deadline or the network is an unreachable server: fall back to the offline cache.
			if (entry.reason !== 'bad_json') response = undefined;
		}
		entry.ms = Math.round(performance.now() - start);
		if (body && Array.isArray(body.memories)) {
			const memories = body.memories;
			const formatted = formatInjectionBlock({
				memories,
				banners,
				budget: config.bootstrapBudget,
				nonce: options.nonce,
				ordered: true,
			});
			entry.hits = memories.length;
			entry.injected = formatted.includedMemories.length;
			if (entry.injected > 0) entry.outcome = 'injected';
			else entry.outcome = memories.length === 0 ? 'empty' : 'over_budget';
			recordMemoriesInState(state, memories, formatted.includedMemories);
			persist(entry, () => saveSessionState(config, sessionId, state));
			persist(entry, () => saveBootstrapCache(config, memories));
			if (shouldSpawnFollower) {
				ensureFollowerRunning(config, sessionId, env);
			}
			return hookOutput('SessionStart', formatted.text);
		}
		if (!entry.outcome) {
			entry.outcome = 'error';
			entry.reason = 'bad_body';
		}
	}
	entry.ms ??= Math.round(performance.now() - start);

	if (response && response.status < 500) {
		return {};
	}

	if (shouldSpawnFollower) {
		ensureFollowerRunning(config, sessionId, env);
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
	entry.stale = formatted.includedMemories.length;
	recordMemoriesInState(state, cached.memories, formatted.includedMemories);
	persist(entry, () => saveSessionState(config, sessionId, state));
	return hookOutput('SessionStart', formatted.text);
}

async function searchForRecall(config, query, fetchImpl, entry) {
	const url = `${config.baseUrl}/Memory/?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(config.recallLimit)}&watch=true`;
	const signal = AbortSignal.timeout(config.recallTimeoutMs);
	const start = performance.now();
	try {
		const response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: config.authorization,
			},
			redirect: 'error',
			signal,
		});
		if (!response.ok) {
			entry.outcome = `http_${response.status}`;
			return response.status === 401 || response.status === 403 ? undefined : [];
		}
		const body = await response.json();
		if (!Array.isArray(body?.memories)) {
			entry.outcome = 'error';
			entry.reason = 'bad_body';
			return [];
		}
		entry.hits = body.memories.length;
		return body.memories;
	} catch (error) {
		if (signal.aborted) {
			entry.outcome = 'timeout';
		} else {
			entry.outcome = 'error';
			entry.reason = error instanceof SyntaxError ? 'bad_json' : 'network';
			entry.code = errorCode(error);
		}
		return [];
	} finally {
		entry.ms = Math.round(performance.now() - start);
	}
}

export async function handleUserPromptSubmit(input = {}, options = {}) {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	const sessionId = String(input.session_id || 'default');
	const entry = { event: 'recall', session: sessionKey(sessionId) };
	return recordedHook(config, entry, () => recallForPrompt(config, env, sessionId, input, options, entry));
}

async function recallForPrompt(config, env, sessionId, input, options, entry) {
	if (!config.configured) {
		entry.outcome = 'unconfigured';
		entry.reason = config.unconfiguredReason;
		return {};
	}

	const rawPrompt = input.prompt ?? input.user_prompt ?? '';
	const query = buildRecallQuery(rawPrompt);

	const state = loadSessionState(config, sessionId);
	if (state.corrupt) {
		entry.outcome = 'error';
		entry.reason = 'corrupt_state';
		return {};
	}

	const shouldSpawnFollower = options.spawnFollower ?? !options.fetchImpl;
	if (shouldSpawnFollower) {
		ensureFollowerRunning(config, sessionId, env);
	}

	const { events: drainedEvents, nextOffset } = drainFollowerEvents(config, sessionId, state.eventsOffset);
	let recalledMemories = [];

	if (!config.recallEnabled) {
		entry.outcome = 'disabled';
	} else if (query.length === 0) {
		entry.outcome = 'skipped';
		entry.reason = 'empty_query';
	} else if (!hasDistinctiveTerm(query)) {
		entry.outcome = 'skipped';
		entry.reason = 'short_query';
	} else {
		recalledMemories = await searchForRecall(config, query, options.fetchImpl ?? globalThis.fetch, entry);
		if (recalledMemories === undefined) {
			purgeBootstrapCache(config);
			return {};
		}
	}

	let dirty = false;
	if (nextOffset !== state.eventsOffset) {
		state.eventsOffset = nextOffset;
		dirty = true;
	}

	const candidateNotices = buildChangeNotices(state, drainedEvents, recalledMemories);

	const injectedSet = new Set(state.injectedIds);
	const activeRecalledMemories = recalledMemories.filter(
		(memory) => memory && typeof memory.id === 'string' && (!memory.status || memory.status === 'active'),
	);
	const uninjectedMemories = activeRecalledMemories.filter((memory) => !injectedSet.has(memory.id));

	const formatted = formatInjectionBlock({
		memories: uninjectedMemories,
		notices: candidateNotices,
		budget: config.recallBudget,
		nonce: options.nonce,
	});
	entry.injected = formatted.includedMemories.length;
	entry.notices = formatted.includedNotices.length;
	if (!entry.outcome) {
		if (entry.injected > 0) entry.outcome = 'injected';
		else if (activeRecalledMemories.length === 0) entry.outcome = 'empty';
		else if (uninjectedMemories.length === 0) entry.outcome = 'deduped';
		else entry.outcome = 'over_budget';
	}

	if (commitChangeNotices(state, candidateNotices, formatted.includedNotices, config)) {
		dirty = true;
	}

	if (recordMemoriesInState(state, activeRecalledMemories, formatted.includedMemories)) {
		dirty = true;
	}

	if (dirty) {
		persist(entry, () => saveSessionState(config, sessionId, state));
	}

	return hookOutput('UserPromptSubmit', formatted.text);
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
