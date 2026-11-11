import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deployDir = new URL('../deploy/', import.meta.url).pathname;

function run(script, args, env) {
	return spawnSync('bash', [join(deployDir, script), ...args], {
		env: { PATH: process.env.PATH, ...env },
		encoding: 'utf8',
	});
}

describe('deploy/deploy.sh', () => {
	const envDir = join(deployDir, 'engineering');
	const host = { AGENT_MEMORY_DEPLOY_HOST: 'host.invalid', AGENT_MEMORY_CONTAINER_MATCH: 'match' };

	it('prints usage and fails without the host and container variables', () => {
		for (const env of [{}, { AGENT_MEMORY_DEPLOY_HOST: host.AGENT_MEMORY_DEPLOY_HOST }]) {
			const result = run('deploy.sh', [envDir], env);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /^usage: /);
		}
	});

	it('prints usage and fails without an env dir', () => {
		const result = run('deploy.sh', [], host);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /^usage: /);
	});

	it('rejects an env dir that is not an app', () => {
		const result = run('deploy.sh', [deployDir], host);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /has no config\.yaml/);
	});
});

describe('deploy/engineering/provision-user.sh', () => {
	it('fails without the cluster variables instead of defaulting to one', () => {
		const result = run('engineering/provision-user.sh', ['someone', 'eng', 'none'], {});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /AGENT_MEMORY_DEPLOY_HOST/);
	});

	describe('container selection', () => {
		let stubs;
		before(() => {
			// ssh runs the remote command locally; docker answers from STUB_CONTAINERS.
			stubs = mkdtempSync(join(tmpdir(), 'deploy-stubs-'));
			writeFileSync(join(stubs, 'ssh'), '#!/usr/bin/env bash\nshift 3\nbash -c "$1"\n');
			writeFileSync(
				join(stubs, 'docker'),
				'#!/usr/bin/env bash\ncase "$1" in\n  ps) printf "%s\\n" $STUB_CONTAINERS;;\n  exec) cat >/dev/null; echo \'{"message":"ok"}\';;\nesac\n',
			);
			for (const name of ['ssh', 'docker']) chmodSync(join(stubs, name), 0o755);
		});
		after(() => rmSync(stubs, { recursive: true, force: true }));

		const provision = (match, containers) =>
			run('engineering/provision-user.sh', ['someone', 'eng', 'none'], {
				PATH: `${stubs}:${process.env.PATH}`,
				AGENT_MEMORY_DEPLOY_HOST: 'host.invalid',
				AGENT_MEMORY_CONTAINER_MATCH: match,
				STUB_CONTAINERS: containers,
			});

		it('uses the one container that matches', () => {
			const result = provision('match', 'other match-1');
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /add_user ok/);
		});

		it('refuses when no container matches', () => {
			const result = provision('match', 'other');
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /need exactly one running container matching match/);
		});

		it('refuses when several containers match instead of taking the first', () => {
			const result = provision('match', 'match-1 match-2');
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /match-1 match-2/);
		});

		it('reads a match that starts with a dash as text, not as a grep option', () => {
			const result = provision('-x', 'other a-x');
			assert.equal(result.status, 0, result.stderr);
		});
	});
});

describe('deploy/ in a public repo', () => {
	const files = readdirSync(deployDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));

	it('names no Fabric host', () => {
		assert.ok(files.length > 0);
		for (const path of files) assert.doesNotMatch(readFileSync(path, 'utf8'), /harperfabric\.com/, path);
	});

	it('gives the target variables no default', () => {
		for (const path of files.filter((file) => file.endsWith('.sh'))) {
			assert.doesNotMatch(readFileSync(path, 'utf8'), /\$\{AGENT_MEMORY_\w+:-[^}]/, path);
		}
	});
});
