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
	shellQuote,
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

		it('deletes a key set to undefined', () => {
			const path = join(dir, 'settings-remove.json');
			writeFileSync(path, JSON.stringify({ env: { AGENT_MEMORY_ENV_FILE: '/old', FOO: '1' } }));
			setSettingsEnv(path, { AGENT_MEMORY_ENV_FILE: undefined });
			assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).env, { FOO: '1' });
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

		it('keeps a server whose name only starts with agent-memory, and drops a quoted-key block', () => {
			const before =
				'[mcp_servers.agent-memory]\nurl = "old"\n\n[mcp_servers.agent-memory-tools]\nurl = "keep"\n\n[mcp_servers."agent-memory"]\nurl = "quoted"\n';
			const after = setCodexMcpServer(before, 'https://memory.example.com/mcp', 'Basic dTpw');
			assert.match(after, /\[mcp_servers\.agent-memory-tools\]\nurl = "keep"/);
			assert.doesNotMatch(after, /old|quoted/);
			assert.equal(after.match(/\[mcp_servers\.agent-memory\]/g).length, 1);
		});

		it('ignores agent-memory headers inside comments and removes indented and literal-quoted ones', () => {
			const before =
				'model = "o3"\n# [mcp_servers.agent-memory] example\nkeep = 1\n  [mcp_servers.\'agent-memory\']\nurl = "old"\n  [other]\nb = 2\n';
			const after = setCodexMcpServer(before, 'https://memory.example.com/mcp', 'Basic dTpw');
			assert.match(after, /^model = "o3"\n# \[mcp_servers\.agent-memory\] example\nkeep = 1\n {2}\[other\]\nb = 2\n/);
			assert.doesNotMatch(after, /old/);
		});

		it('replaces an earlier agent-memory hook where it stands, so other hooks keep their positions', () => {
			const other = { type: 'command', command: 'other-hook', timeout: 1 };
			const old = { type: 'command', command: 'node "/old/agent-memory/0.1.0/hooks/hook.mjs"', timeout: 5 };
			const ours = { type: 'command', command: "'/x/agent-memory/plugin/hooks/hook.mjs'", timeout: 5 };
			const result = setCodexHooks(
				{ hooks: { SessionStart: [{ matcher: 'startup', hooks: [old] }, { hooks: [other] }] } },
				ours.command,
			);
			assert.deepEqual(result.hooks.SessionStart, [{ matcher: 'startup', hooks: [ours] }, { hooks: [other] }]);
			assert.deepEqual(result.hooks.SessionEnd, [{ hooks: [{ ...ours, timeout: 3 }] }]);
			assert.deepEqual(Object.keys(result.hooks), ['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
		});

		it('quotes hook command words so the shell runs the path literally', () => {
			assert.equal(shellQuote("/a b/$HOME/it's"), `'/a b/$HOME/it'\\''s'`);
			const echoed = spawnSync('sh', ['-c', `printf %s ${shellQuote("/a b/$HOME/it's")}`], { encoding: 'utf8' });
			assert.equal(echoed.stdout, "/a b/$HOME/it's");
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
			const command = `env -u AGENT_MEMORY_URL -u AGENT_MEMORY_TOKEN '/usr/bin/node' '${join(codexHome, 'agent-memory/plugin/hooks/hook.mjs')}'`;
			assert.equal(hooks.SessionStart[0].hooks[0].command, command);
			assert.equal(first.match(/trusted_hash/g).length, 3);
			const key = `${join(codexHome, 'hooks.json')}:session_start:0:0`;
			const hash = codexHookHash('session_start', hooks.SessionStart[0].hooks[0]);
			assert.ok(first.includes(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"`));
		});

		it('on a fresh Codex home, takes no backup of its own output and points the hooks at the env file it used', () => {
			const codexHome = join(dir, 'fresh-codex');
			const options = {
				codexHome,
				pluginRoot: pluginDir,
				node: '/usr/bin/node',
				mcpUrl: 'https://memory.example.com/mcp',
				authorization: 'Basic dTpw',
				envFile: '/etc/team b/env',
			};
			configureCodex(options);
			configureCodex(options);
			assert.equal(existsSync(join(codexHome, 'config.toml.pre-agent-memory')), false);
			assert.equal(existsSync(join(codexHome, 'hooks.json.pre-agent-memory')), false);
			const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks;
			assert.match(
				hooks.UserPromptSubmit[0].hooks[0].command,
				/^env -u AGENT_MEMORY_URL -u AGENT_MEMORY_TOKEN AGENT_MEMORY_ENV_FILE='\/etc\/team b\/env' '\/usr\/bin\/node' /,
			);
		});
	});

	describe('probeHooks', () => {
		let server;
		let url;
		before(async () => {
			// In its own process: probeHooks blocks this one while the hook runs. Under /deny every request is refused;
			// elsewhere every request finds no memories.
			server = spawn(process.execPath, [
				'-e',
				`require('http').createServer((q, s) => {
					const deny = q.url.startsWith('/deny/');
					s.writeHead(deny ? 401 : 200, { 'content-type': 'application/json' });
					s.end(deny ? '{}' : '{"memories":[]}');
				}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`,
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
				env: { PATH: process.env.PATH, HOME: home, AGENT_MEMORY_ENV_FILE: envFile('probe-deny', `${url}/deny`) },
			});
			assert.equal(result.ok, false);
			assert.match(result.lines[0], /^SessionStart: http_401,/);
			assert.match(result.lines[1], /^UserPromptSubmit: http_401,/);
			assert.equal(existsSync(join(home, '.cache')), false);
		});

		it('passes when both hooks get an answer, fails on a skipped recall, and accepts recall switched off', () => {
			const env = {
				PATH: process.env.PATH,
				HOME: join(dir, 'probe-home'),
				AGENT_MEMORY_ENV_FILE: envFile('probe', url),
			};
			const answered = probeHooks({ pluginRoot: pluginDir, prompt: 'replication catch-up after restart', env });
			assert.deepEqual(
				answered.lines.map((line) => line.split(',')[0]),
				['SessionStart: empty', 'UserPromptSubmit: empty'],
			);
			assert.equal(answered.ok, true);
			const skipped = probeHooks({ pluginRoot: pluginDir, prompt: 'yes', env });
			assert.match(skipped.lines[1], /^UserPromptSubmit: skipped/);
			assert.equal(skipped.ok, false);
			const off = probeHooks({ pluginRoot: pluginDir, prompt: 'yes', env: { ...env, AGENT_MEMORY_RECALL: 'off' } });
			assert.match(off.lines[1], /^UserPromptSubmit: disabled/);
			assert.equal(off.ok, true);
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
[ "$2 $3" = "marketplace list" ] && echo '[{"name":"team-agent-memory"}]'
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
				`${profile} plugin marketplace list --json`,
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
