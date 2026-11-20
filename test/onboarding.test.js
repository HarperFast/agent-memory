import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	codexHookHash,
	configureCodex,
	probeHooks,
	resolveCredentials,
	setCodexHooks,
	setCodexMcpServer,
	setSettingsEnv,
} from '../scripts/onboarding/lib.mjs';

const onboardingDir = new URL('../scripts/onboarding/', import.meta.url).pathname;
const pluginDir = new URL('../claude-plugin/', import.meta.url).pathname;

describe('onboarding scripts', () => {
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'onboarding-'));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	function envFile(name, url = 'https://memory.example.com') {
		const path = join(dir, name);
		writeFileSync(path, `AGENT_MEMORY_URL="${url}"\nAGENT_MEMORY_TOKEN=Basic dTpw\nAGENT_MEMORY_USER=someone\n`, {
			mode: 0o600,
		});
		return path;
	}

	describe('resolveCredentials', () => {
		it('reads the env file, not a URL or token exported in the shell', () => {
			const config = resolveCredentials({
				AGENT_MEMORY_ENV_FILE: envFile('creds'),
				AGENT_MEMORY_URL: 'https://other.example.com',
				AGENT_MEMORY_TOKEN: 'other',
			});
			assert.equal(config.baseUrl, 'https://memory.example.com');
			assert.equal(config.authorization, 'Basic dTpw');
		});

		it('names what is missing', () => {
			assert.throws(() => resolveCredentials({ AGENT_MEMORY_ENV_FILE: join(dir, 'absent') }), /missing_url/);
		});
	});

	describe('setSettingsEnv', () => {
		it('merges into env and keeps every other setting', () => {
			const path = join(dir, 'settings.json');
			writeFileSync(path, JSON.stringify({ theme: 'dark', env: { FOO: '1' } }));
			setSettingsEnv(path, { AGENT_MEMORY_URL: 'https://memory.example.com' });
			assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
				theme: 'dark',
				env: { FOO: '1', AGENT_MEMORY_URL: 'https://memory.example.com' },
			});
		});

		it('refuses to overwrite a file that is not valid JSON', () => {
			const path = join(dir, 'broken.json');
			writeFileSync(path, '{"theme": ');
			assert.throws(() => setSettingsEnv(path, { A: 'b' }), /not valid JSON/);
			assert.equal(readFileSync(path, 'utf8'), '{"theme": ');
		});
	});

	describe('Codex config', () => {
		it('replaces an earlier agent-memory MCP block and keeps other tables', () => {
			const before =
				'[model]\nname = "x"\n\n[mcp_servers.agent-memory]\nurl = "old"\n\n[mcp_servers.agent-memory.env]\nA = "1"\n\n[other]\nb = 1\n';
			const after = setCodexMcpServer(before, 'https://memory.example.com/mcp', 'Basic dTpw');
			assert.doesNotMatch(after, /old|A = "1"/);
			assert.match(after, /\[model\]\nname = "x"/);
			assert.match(after, /\[other\]\nb = 1/);
			assert.match(
				after,
				/url = "https:\/\/memory\.example\.com\/mcp"\nhttp_headers = \{ Authorization = "Basic dTpw" \}/,
			);
			assert.equal(setCodexMcpServer(after, 'https://memory.example.com/mcp', 'Basic dTpw'), after);
		});

		it('replaces earlier agent-memory hooks and keeps the others', () => {
			const other = { type: 'command', command: 'other-hook', timeout: 1 };
			const old = { type: 'command', command: 'node "/old/agent-memory/0.1.0/hooks/hook.mjs"', timeout: 5 };
			const result = setCodexHooks(
				{ hooks: { SessionStart: [{ hooks: [other, old] }] } },
				'node "/x/agent-memory/plugin/hooks/hook.mjs"',
			);
			assert.deepEqual(result.hooks.SessionStart, [
				{ hooks: [other] },
				{ hooks: [{ type: 'command', command: 'node "/x/agent-memory/plugin/hooks/hook.mjs"', timeout: 5 }] },
			]);
			assert.deepEqual(Object.keys(result.hooks), ['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
		});

		it('hashes the handler identity the way Codex does', () => {
			const command = 'node "/x/agent-memory/plugin/hooks/hook.mjs"';
			// Sorted keys, compact JSON; SessionEnd timeouts are clamped to 1..3.
			const expected = (json) => 'sha256:' + createHash('sha256').update(json).digest('hex');
			assert.equal(
				codexHookHash('session_start', { type: 'command', command, timeout: 5 }),
				expected(
					`{"event_name":"session_start","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":5,"type":"command"}]}`,
				),
			);
			assert.equal(
				codexHookHash('session_end', { type: 'command', command, timeout: 9 }, 'startup'),
				expected(
					`{"event_name":"session_end","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":3,"type":"command"}],"matcher":"startup"}`,
				),
			);
		});

		it('configures a Codex home idempotently, with a private config.toml and a stable copy of the hook', () => {
			const codexHome = join(dir, 'codex');
			mkdirSync(codexHome);
			writeFileSync(join(codexHome, 'config.toml'), '[model]\nname = "x"\n', { mode: 0o644 });
			const options = {
				codexHome,
				pluginRoot: pluginDir,
				node: '/usr/bin/node',
				mcpUrl: 'https://memory.example.com/mcp',
				authorization: 'Basic dTpw',
			};
			configureCodex(options);
			const first = readFileSync(join(codexHome, 'config.toml'), 'utf8');
			configureCodex(options);
			assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), first);
			assert.equal(statSync(join(codexHome, 'config.toml')).mode & 0o777, 0o600);
			assert.equal(readFileSync(join(codexHome, 'config.toml.pre-agent-memory'), 'utf8'), '[model]\nname = "x"\n');
			assert.ok(existsSync(join(codexHome, 'agent-memory/plugin/lib/hooks.mjs')));
			const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks;
			const command = `"/usr/bin/node" ${JSON.stringify(join(codexHome, 'agent-memory/plugin/hooks/hook.mjs'))}`;
			assert.equal(hooks.SessionStart[0].hooks[0].command, command);
			assert.equal(first.match(/trusted_hash/g).length, 3);
			const key = `${join(codexHome, 'hooks.json')}:session_start:0:0`;
			const hash = codexHookHash('session_start', hooks.SessionStart[0].hooks[0]);
			assert.ok(first.includes(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"`));
		});
	});

	describe('probeHooks', () => {
		let server;
		let url;
		before(async () => {
			// In its own process: probeHooks blocks this one while the hook runs.
			server = spawn(process.execPath, [
				'-e',
				`require('http').createServer((q, s) => { s.writeHead(401); s.end('{}'); })
					.listen(0, '127.0.0.1', function () { console.log(this.address().port); });`,
			]);
			const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
			url = `http://127.0.0.1:${port}`;
		});
		after(() => server.kill());

		it('reports a refused credential as a failure, without touching the real cache', () => {
			const home = join(dir, 'probe-home');
			mkdirSync(home);
			const result = probeHooks({
				pluginRoot: pluginDir,
				prompt: 'replication catch-up after restart',
				env: { PATH: process.env.PATH, HOME: home, AGENT_MEMORY_ENV_FILE: envFile('probe', url) },
			});
			assert.equal(result.ok, false);
			assert.match(result.lines[0], /^SessionStart: http_401,/);
			assert.match(result.lines[1], /^UserPromptSubmit: http_401,/);
			assert.equal(existsSync(join(home, '.cache')), false);
		});

		it('reports an unconfigured install', () => {
			const result = probeHooks({
				pluginRoot: pluginDir,
				prompt: 'replication catch-up after restart',
				env: { PATH: process.env.PATH, HOME: join(dir, 'empty-home') },
			});
			assert.equal(result.ok, false);
			assert.match(result.lines[0], /^SessionStart: unconfigured \(missing_url\)/);
		});
	});

	describe('install-claude-profile.sh', () => {
		it('installs through the claude CLI and sets AGENT_MEMORY_URL in the profile settings', () => {
			const bin = join(dir, 'bin');
			const profile = join(dir, 'profile');
			mkdirSync(bin);
			// A stub claude: logs its arguments, and on install writes the record the real CLI writes.
			writeFileSync(
				join(bin, 'claude'),
				`#!/usr/bin/env bash
echo "$CLAUDE_CONFIG_DIR $*" >> "${join(dir, 'claude.log')}"
if [ "$2" = install ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/plugins/cache/p/hooks" && touch "$CLAUDE_CONFIG_DIR/plugins/cache/p/hooks/hook.mjs"
  printf '{"plugins":{"agent-memory@agent-memory":[{"scope":"user","installPath":"%s"}]}}' "$CLAUDE_CONFIG_DIR/plugins/cache/p" > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
fi
`,
			);
			chmodSync(join(bin, 'claude'), 0o755);
			const result = spawnSync('bash', [join(onboardingDir, 'install-claude-profile.sh'), profile], {
				env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, AGENT_MEMORY_ENV_FILE: envFile('install') },
				encoding: 'utf8',
			});
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(readFileSync(join(dir, 'claude.log'), 'utf8').trim().split('\n'), [
				`${profile} plugin marketplace list`,
				`${profile} plugin marketplace add HarperFast/agent-memory`,
				`${profile} plugin install agent-memory@agent-memory --scope user`,
			]);
			assert.deepEqual(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).env, {
				AGENT_MEMORY_URL: 'https://memory.example.com',
				AGENT_MEMORY_ENV_FILE: join(dir, 'install'),
			});
			assert.match(result.stdout, /agent-memory@agent-memory p installed/);
		});

		it('refuses before touching the profile when the env file has no credentials', () => {
			const result = spawnSync('bash', [join(onboardingDir, 'install-claude-profile.sh'), join(dir, 'unprovisioned')], {
				env: { PATH: process.env.PATH, HOME: join(dir, 'nobody') },
				encoding: 'utf8',
			});
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /missing_url/);
			assert.equal(existsSync(join(dir, 'unprovisioned', 'settings.json')), false);
		});
	});

	it('hook-test.sh fails clearly when the plugin is not installed', () => {
		const result = spawnSync('bash', [join(onboardingDir, 'hook-test.sh'), join(dir, 'no-profile')], {
			env: { PATH: process.env.PATH, HOME: dir },
			encoding: 'utf8',
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /is not installed in/);
	});
});
