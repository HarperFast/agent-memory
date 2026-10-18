import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BOOTSTRAP_BUDGET = 4000;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 3000;
export const DEFAULT_RECALL_BUDGET = 2000;
export const DEFAULT_RECALL_TIMEOUT_MS = 1500;
export const DEFAULT_RECALL_LIMIT = 5;
export const DEFAULT_FOLLOWER_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_WATCH_RENEW_MS = 45 * 60 * 1000;
export const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const QUERY_MAX_CHARS = 1000;

export function parseEnvContent(content) {
	const entries = {};
	for (const rawLine of String(content).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
		const eqIndex = stripped.indexOf('=');
		if (eqIndex <= 0) continue;
		const key = stripped.slice(0, eqIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = stripped.slice(eqIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		entries[key] = value;
	}
	return entries;
}

export function loadEnvFile(envFilePath) {
	try {
		const stat = statSync(envFilePath);
		const insecurePermissions = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
		const content = readFileSync(envFilePath, 'utf8');
		return { entries: parseEnvContent(content), insecurePermissions };
	} catch {
		return { entries: {}, insecurePermissions: false };
	}
}

export function isLoopbackHostname(hostname) {
	const lower = String(hostname).toLowerCase();
	return (
		lower === 'localhost' ||
		lower === '127.0.0.1' ||
		lower === '::1' ||
		lower === '[::1]' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)
	);
}

export function validateBaseUrl(rawUrl, allowInsecureHttp = false) {
	if (!rawUrl || typeof rawUrl !== 'string') return undefined;
	let parsed;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		return undefined;
	}
	if (parsed.username || parsed.password) return undefined;
	if (parsed.protocol === 'https:') {
		return parsed
			.toString()
			.replace(/\/+$/, '')
			.replace(/\/Memory$/i, '');
	}
	if (parsed.protocol === 'http:' && (allowInsecureHttp || isLoopbackHostname(parsed.hostname))) {
		return parsed
			.toString()
			.replace(/\/+$/, '')
			.replace(/\/Memory$/i, '');
	}
	return undefined;
}

export function formatAuthorizationHeader(rawToken) {
	if (!rawToken || typeof rawToken !== 'string') return undefined;
	const trimmed = rawToken.trim();
	if (!trimmed || /[\r\n\0]/.test(trimmed)) return undefined;
	if (/^(Bearer|Basic)\s+\S+/i.test(trimmed)) return trimmed;
	return `Bearer ${trimmed}`;
}

function parsePositiveInt(raw, fallback, min = 1, max = 1_000_000_000) {
	if (raw === undefined || raw === null || raw === '') return fallback;
	const parsed = Number.parseInt(String(raw), 10);
	if (!Number.isFinite(parsed) || parsed < min) return fallback;
	return Math.min(parsed, max);
}

export function resolveConfig(env = process.env) {
	const home = env.HOME || homedir();
	const envFilePath = env.AGENT_MEMORY_ENV_FILE || join(home, '.config', 'agent-memory', 'env');
	const hasEnvUrl = Boolean(env.AGENT_MEMORY_URL && env.AGENT_MEMORY_URL.trim());
	const hasEnvToken = Boolean(env.AGENT_MEMORY_TOKEN && env.AGENT_MEMORY_TOKEN.trim());
	const fileData = !hasEnvUrl || !hasEnvToken ? loadEnvFile(envFilePath) : { entries: {}, insecurePermissions: false };
	const merged = { ...fileData.entries, ...env };

	const rawUrl = (hasEnvUrl ? env.AGENT_MEMORY_URL : fileData.entries.AGENT_MEMORY_URL) ?? '';
	const rawToken = (hasEnvToken ? env.AGENT_MEMORY_TOKEN : fileData.entries.AGENT_MEMORY_TOKEN) ?? '';
	const allowInsecureHttp = merged.AGENT_MEMORY_ALLOW_INSECURE_HTTP === '1';
	const baseUrl = validateBaseUrl(rawUrl, allowInsecureHttp);
	const authorization = formatAuthorizationHeader(rawToken);
	const recallFlag = String(merged.AGENT_MEMORY_RECALL ?? '')
		.trim()
		.toLowerCase();
	const recallEnabled = recallFlag !== 'off' && recallFlag !== '0' && recallFlag !== 'false';
	const disableFollowerFlag = String(merged.AGENT_MEMORY_DISABLE_FOLLOWER ?? merged.AGENT_MEMORY_FOLLOWER ?? '')
		.trim()
		.toLowerCase();
	const followerEnabled =
		disableFollowerFlag !== '1' && disableFollowerFlag !== 'true' && disableFollowerFlag !== 'off';

	return {
		baseUrl,
		authorization,
		configured: Boolean(baseUrl && authorization),
		urlFromEnvFile: !hasEnvUrl && Boolean(fileData.entries.AGENT_MEMORY_URL),
		envFileInsecurePermissions: fileData.insecurePermissions,
		envFilePath,
		userId: merged.AGENT_MEMORY_USER ? String(merged.AGENT_MEMORY_USER).trim() : undefined,
		bootstrapBudget: parsePositiveInt(merged.AGENT_MEMORY_BOOTSTRAP_BUDGET, DEFAULT_BOOTSTRAP_BUDGET, 100, 100_000),
		bootstrapTimeoutMs: parsePositiveInt(
			merged.AGENT_MEMORY_BOOTSTRAP_TIMEOUT_MS,
			DEFAULT_BOOTSTRAP_TIMEOUT_MS,
			50,
			30_000,
		),
		recallBudget: parsePositiveInt(merged.AGENT_MEMORY_RECALL_BUDGET, DEFAULT_RECALL_BUDGET, 100, 100_000),
		recallTimeoutMs: parsePositiveInt(
			merged.AGENT_MEMORY_RECALL_TIMEOUT_MS ?? merged.AGENT_MEMORY_TIMEOUT_MS,
			DEFAULT_RECALL_TIMEOUT_MS,
			50,
			30_000,
		),
		recallLimit: parsePositiveInt(merged.AGENT_MEMORY_RECALL_LIMIT, DEFAULT_RECALL_LIMIT, 1, 50),
		recallEnabled,
		followerEnabled,
		followerTtlMs: parsePositiveInt(merged.AGENT_MEMORY_FOLLOWER_TTL_MS, DEFAULT_FOLLOWER_TTL_MS, 1000, 86_400_000),
		heartbeatMs: parsePositiveInt(merged.AGENT_MEMORY_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 50, 300_000),
		watchRenewMs: parsePositiveInt(merged.AGENT_MEMORY_WATCH_RENEW_MS, DEFAULT_WATCH_RENEW_MS, 50, 3_600_000),
		cacheMaxAgeMs: parsePositiveInt(merged.AGENT_MEMORY_CACHE_MAX_AGE_MS, DEFAULT_CACHE_MAX_AGE_MS, 1000, 604_800_000),
		cacheDir: merged.AGENT_MEMORY_CACHE_DIR || join(home, '.cache', 'agent-memory', 'claude-plugin'),
	};
}
