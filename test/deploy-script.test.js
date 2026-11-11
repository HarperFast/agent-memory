import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
