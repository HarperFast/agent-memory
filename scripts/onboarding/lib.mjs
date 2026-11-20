// The file edits and the hook probe behind the onboarding scripts in this directory. The shell scripts call the
// subcommands at the bottom; tests import the functions.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isMainModule, resolveConfig } from '../../claude-plugin/lib/config.mjs';

/** Replaces `path` with `text` in one rename, so an interrupted run leaves the old file or the new one. */
export function writeFileAtomic(path, text, mode) {
	mode ??= existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(temp, text, { mode });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

/** Parses a JSON object file; a missing file is `{}`, anything else that is not an object throws. */
export function readJsonObject(path) {
	if (!existsSync(path)) return {};
	let value;
	try {
		value = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${error.message}); fix or move it, then rerun`);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`);
	return value;
}

/** Claude Code settings.json: merges `env` into its `env` block, keeping everything else. */
export function setSettingsEnv(settingsPath, env) {
	const settings = readJsonObject(settingsPath);
	settings.env = { ...(settings.env ?? {}), ...env };
	writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n');
	return settings;
}

const HOOK_COMMAND = /agent-memory.*[\\/]hooks[\\/]hook\.mjs/;
const CODEX_EVENTS = [
	['SessionStart', 'session_start', 5],
	['UserPromptSubmit', 'user_prompt_submit', 3],
	['SessionEnd', 'session_end', 3],
];

/** Codex config.toml: replaces any earlier `[mcp_servers.agent-memory]` block with one for `mcpUrl`. */
export function setCodexMcpServer(toml, mcpUrl, authorization) {
	// Drop the earlier block: its header through the line before the next table header that is not one of its own.
	const rest = toml.replace(
		/\n?\[mcp_servers\.agent-memory(\.[^\]]*)?\][\s\S]*?(?=\n\[(?!mcp_servers\.agent-memory)|$)/g,
		'',
	);
	const q = JSON.stringify;
	return (
		rest.replace(/\s*$/, '\n') +
		`\n[mcp_servers.agent-memory]\ndefault_tools_approval_mode = "approve"\nurl = ${q(mcpUrl)}\nhttp_headers = { Authorization = ${q(authorization)} }\n`
	);
}

/** Codex hooks.json: replaces earlier agent-memory hooks with one `command` per event, keeping every other hook. */
export function setCodexHooks(hooksJson, command) {
	const hooks = { ...(hooksJson.hooks ?? {}) };
	const strip = (groups) =>
		(groups ?? [])
			.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !HOOK_COMMAND.test(h.command ?? '')) }))
			.filter((group) => group.hooks.length);
	for (const [event, , timeout] of CODEX_EVENTS) {
		hooks[event] = [...strip(hooks[event]), { hooks: [{ type: 'command', command, timeout }] }];
	}
	return { ...hooksJson, hooks };
}

const sortKeys = (v) =>
	Array.isArray(v)
		? v.map(sortKeys)
		: v && typeof v === 'object'
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, sortKeys(v[k])]),
				)
			: v;

/** The trusted_hash Codex records for one hook handler. */
export function codexHookHash(eventLabel, handler, matcher) {
	// Codex hashes a normalized identity (codex-rs/hooks/src/engine/discovery.rs hook_hash,
	// config/src/fingerprint.rs version_for_toml): sha256 of sorted compact JSON {event_name, hooks:[handler]}.
	const timeout =
		eventLabel === 'session_end' ? Math.min(Math.max(handler.timeout ?? 1, 1), 3) : Math.max(handler.timeout ?? 600, 1);
	const identity = {
		event_name: eventLabel,
		hooks: [{ async: !!handler.async, command: handler.command, timeout, type: 'command' }],
	};
	if (matcher != null) identity.matcher = matcher;
	return (
		'sha256:' +
		createHash('sha256')
			.update(JSON.stringify(sortKeys(identity)))
			.digest('hex')
	);
}

/** Codex config.toml: marks the agent-memory hooks in `hooksJson` (read from `hooksPath`) as trusted. */
export function trustCodexHooks(toml, hooksJson, hooksPath) {
	const labels = Object.fromEntries(CODEX_EVENTS.map(([event, label]) => [event, label]));
	for (const [event, groups] of Object.entries(hooksJson.hooks ?? {})) {
		const label = labels[event];
		if (!label) continue;
		groups.forEach((group, gi) =>
			(group.hooks ?? []).forEach((handler, hi) => {
				if (!HOOK_COMMAND.test(handler.command ?? '')) return;
				const header = `[hooks.state.${JSON.stringify(`${hooksPath}:${label}:${gi}:${hi}`)}]`;
				const existing = new RegExp(
					'\\n?' + header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n(?:[^\\[\\n][^\\n]*\\n?)*',
					'g',
				);
				toml =
					toml.replace(existing, '').replace(/\s*$/, '\n') +
					`\n${header}\ntrusted_hash = "${codexHookHash(label, handler, group.matcher)}"\n`;
			}),
		);
	}
	return toml;
}

/** Copies the plugin's runtime (hooks, lib, bin, manifest) to `target`, swapping the whole directory at once. */
export function copyPluginRuntime(pluginRoot, target) {
	if (!existsSync(join(pluginRoot, 'hooks', 'hook.mjs'))) throw new Error(`${pluginRoot} has no hooks/hook.mjs`);
	mkdirSync(dirname(target), { recursive: true });
	const staging = `${target}.new-${process.pid}`;
	const previous = `${target}.old-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	for (const part of ['hooks', 'lib', 'bin', '.claude-plugin']) {
		if (existsSync(join(pluginRoot, part))) cpSync(join(pluginRoot, part), join(staging, part), { recursive: true });
	}
	if (existsSync(target)) renameSync(target, previous);
	renameSync(staging, target);
	rmSync(previous, { recursive: true, force: true });
}

export function configureCodex({ codexHome, pluginRoot, node, mcpUrl, authorization }) {
	const configPath = join(codexHome, 'config.toml');
	const hooksPath = join(codexHome, 'hooks.json');
	mkdirSync(codexHome, { recursive: true });
	for (const path of [configPath, hooksPath]) {
		if (existsSync(path) && !existsSync(`${path}.pre-agent-memory`)) cpSync(path, `${path}.pre-agent-memory`);
	}
	const existingHooks = readJsonObject(hooksPath);
	const toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
	const runtime = join(codexHome, 'agent-memory', 'plugin');
	copyPluginRuntime(pluginRoot, runtime);
	const command = `${JSON.stringify(node)} ${JSON.stringify(join(runtime, 'hooks', 'hook.mjs'))}`;
	const hooksJson = setCodexHooks(existingHooks, command);
	const nextToml = trustCodexHooks(setCodexMcpServer(toml, mcpUrl, authorization), hooksJson, hooksPath);
	// config.toml carries the Authorization header: owner-only, whatever mode it had.
	writeFileAtomic(configPath, nextToml, 0o600);
	writeFileAtomic(hooksPath, JSON.stringify(hooksJson, null, 2) + '\n');
	return { runtime, configPath, hooksPath };
}

const OK_OUTCOMES = new Set(['injected', 'empty', 'deduped', 'over_budget', 'skipped', 'disabled']);

/**
 * Runs the installed hook as Claude Code would for one synthetic session, with its own cache dir so no real
 * session state or diagnostics are touched. Returns one line per event and whether every outcome was healthy.
 */
export function probeHooks({ pluginRoot, prompt, env = process.env, timeoutMs = 15_000 }) {
	const cacheDir = mkdtempSync(join(tmpdir(), 'agent-memory-hook-test-'));
	const session = `hook-test-${process.pid}-${Date.now()}`;
	const hook = join(pluginRoot, 'hooks', 'hook.mjs');
	const childEnv = { ...env, AGENT_MEMORY_CACHE_DIR: cacheDir, AGENT_MEMORY_DISABLE_FOLLOWER: '1' };
	const run = (input) =>
		spawnSync(process.execPath, [hook], {
			input: JSON.stringify(input),
			env: childEnv,
			timeout: timeoutMs,
			encoding: 'utf8',
		});
	const lines = [];
	let ok = true;
	try {
		for (const [hookEvent, event] of [
			['SessionStart', 'bootstrap'],
			['UserPromptSubmit', 'recall'],
		]) {
			const result = run({ session_id: session, hook_event_name: hookEvent, source: 'startup', prompt, cwd: env.HOME });
			let context = '';
			try {
				context = JSON.parse(result.stdout.trim().split('\n').pop()).hookSpecificOutput?.additionalContext ?? '';
			} catch {}
			const count = (pattern) => (context.match(pattern) ?? []).length;
			const record = readDiagnosticsFile(cacheDir).findLast((entry) => entry.event === event);
			const outcome = result.error?.code === 'ETIMEDOUT' ? 'hook_timeout' : (record?.outcome ?? 'no_diagnostics');
			if (!OK_OUTCOMES.has(outcome)) ok = false;
			lines.push(
				`${hookEvent}: ${outcome}${record?.reason ? ` (${record.reason})` : ''}, ${context.length} chars, ` +
					`orientation=${count(/section=\\?"orientation/g)} memories=${count(/\[memory-[0-9a-f]+ /g)} topics=${count(/\[topic-[0-9a-f]+ /g)}`,
			);
		}
		run({ session_id: session, hook_event_name: 'SessionEnd' });
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
	return { ok, lines };
}

function readDiagnosticsFile(cacheDir) {
	try {
		return readFileSync(join(cacheDir, 'diagnostics.jsonl'), 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** The endpoint and credential from the env file, parsed as the plugin's hooks parse it; throws when unusable. */
export function resolveCredentials(env = process.env) {
	// The env file is the source of truth for an install: a URL or token exported in this shell is not.
	const { AGENT_MEMORY_URL, AGENT_MEMORY_TOKEN, ...rest } = env;
	const config = resolveConfig(rest);
	if (!config.configured) {
		throw new Error(
			`${config.unconfiguredReason} in ${config.envFilePath} or the environment: provision a user first (docs/onboarding.md)`,
		);
	}
	return config;
}

if (isMainModule(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2);
	try {
		if (command === 'claude-settings') {
			const { baseUrl } = resolveCredentials();
			const env = { AGENT_MEMORY_URL: baseUrl };
			// A non-default env file must reach the hooks too, or they find no token.
			if (process.env.AGENT_MEMORY_ENV_FILE) env.AGENT_MEMORY_ENV_FILE = process.env.AGENT_MEMORY_ENV_FILE;
			setSettingsEnv(args[0], env);
		} else if (command === 'configure-codex') {
			const { baseUrl, authorization, userId } = resolveCredentials();
			const [codexHome, pluginRoot] = args;
			const { runtime } = configureCodex({
				codexHome,
				pluginRoot,
				// The PATH entry (a stable symlink under Homebrew), not process.execPath (a versioned Cellar path).
				node: process.env.NODE_BIN || process.execPath,
				mcpUrl: `${baseUrl}/mcp`,
				authorization,
			});
			console.log(
				`${codexHome}: agent-memory MCP server and hooks configured${userId ? ` for ${userId}` : ''}; hooks run ${runtime}`,
			);
		} else if (command === 'probe-hooks') {
			const [pluginRoot, prompt] = args;
			const { ok, lines } = probeHooks({ pluginRoot, prompt });
			for (const line of lines) console.log(line);
			if (!ok) {
				console.error('a hook did not get a healthy answer from the server; see docs/onboarding.md › Verify');
				process.exitCode = 1;
			}
		} else {
			console.error(`unknown command ${command}`);
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
