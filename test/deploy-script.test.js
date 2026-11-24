import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
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

// ssh runs the remote command locally; docker logs each operation it receives to STUB_LOG (one JSON per line) and
// answers list_users with STUB_USERS, everything else with ok.
function clusterStubs() {
	const dir = mkdtempSync(join(tmpdir(), 'deploy-cluster-'));
	writeFileSync(join(dir, 'ssh'), '#!/usr/bin/env bash\nshift 3\nbash -c "$1"\n');
	writeFileSync(
		join(dir, 'docker'),
		[
			'#!/usr/bin/env bash',
			'case "$1" in',
			'  ps) echo match-1;;',
			'  exec) body="$(cat)"; printf "%s\\n" "$body" >>"$STUB_LOG"',
			'    case "$body" in *list_users*) printf "%s\\n" "$STUB_USERS";; *) echo \'{"message":"ok"}\';; esac;;',
			'esac',
			'',
		].join('\n'),
	);
	for (const name of ['ssh', 'docker']) chmodSync(join(dir, name), 0o755);
	return dir;
}

const operationsLogged = (log) =>
	existsSync(log)
		? readFileSync(log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

describe('deploy/engineering/provision-user.sh roles, targets and delegation', () => {
	let stubs;
	let work;
	before(() => {
		stubs = clusterStubs();
	});
	after(() => rmSync(stubs, { recursive: true, force: true }));

	const users = JSON.stringify([
		{ username: 'kris@example.com', role: { role: 'eng' } },
		{ username: 'pat@example.com', role: { role: 'eng-public' } },
	]);
	function provision(args) {
		work = mkdtempSync(join(tmpdir(), 'provision-run-'));
		const log = join(work, 'ops.log');
		const result = run('engineering/provision-user.sh', args, {
			PATH: `${stubs}:${process.env.PATH}`,
			AGENT_MEMORY_DEPLOY_HOST: 'host.invalid',
			AGENT_MEMORY_CONTAINER_MATCH: 'match',
			AGENT_MEMORY_URL: 'https://memory.invalid',
			STUB_LOG: log,
			STUB_USERS: users,
		});
		return { ...result, operations: operationsLogged(log), work };
	}

	it('accepts eng-public and provisioner, and still refuses other roles', () => {
		for (const role of ['eng-public', 'provisioner']) {
			const result = provision(['someone@example.com', role, 'none']);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.operations[0].operation, 'add_user');
			assert.equal(result.operations[0].role, role);
		}
		const refused = provision(['someone@example.com', 'super_user', 'none']);
		assert.equal(refused.status, 2);
		assert.match(refused.stderr, /unknown role super_user/);
		assert.deepEqual(refused.operations, []);
	});

	it('writes a file: target whole, mode 0600, replacing a readable file without a temp file left behind', () => {
		const dir = mkdtempSync(join(tmpdir(), 'provision-file-'));
		const dest = join(dir, 'provisioner.env');
		writeFileSync(dest, 'old\n', { mode: 0o644 });
		try {
			const result = provision(['dispatch-provisioner', 'provisioner', `file:${dest}`]);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, new RegExp(`credentials written to ${dest}`));
			assert.equal(statSync(dest).mode & 0o777, 0o600);
			const lines = readFileSync(dest, 'utf8').trim().split('\n');
			assert.equal(lines[0], 'AGENT_MEMORY_URL=https://memory.invalid');
			assert.equal(lines[2], 'AGENT_MEMORY_USER=dispatch-provisioner');
			const [user, password] = Buffer.from(lines[1].replace('AGENT_MEMORY_TOKEN=Basic ', ''), 'base64')
				.toString()
				.split(':');
			assert.equal(user, 'dispatch-provisioner');
			assert.equal(password, result.operations[0].password);
			assert.doesNotMatch(result.stdout + result.stderr, new RegExp(password));
			assert.deepEqual(readdirSync(dir), ['provisioner.env']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('checks a file: destination before the cluster changes', () => {
		const result = provision(['dispatch-provisioner', 'provisioner', 'file:/nonexistent-dir/provisioner.env']);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /cannot write to \/nonexistent-dir/);
		assert.deepEqual(result.operations, []);
	});

	it('refuses --acts-for across eng-public and another role, or to a missing user, before the cluster changes', () => {
		for (const [role, principal] of [
			['eng-public', 'kris@example.com'],
			['eng-agents', 'pat@example.com'],
			['eng', 'pat@example.com'],
		]) {
			const result = provision([`agent-${role}`, role, 'none', '--acts-for', principal]);
			assert.equal(result.status, 1, `${role} for ${principal}`);
			assert.match(result.stderr, /never shares a delegation group/);
			assert.deepEqual(
				result.operations.map((op) => op.operation),
				['list_users'],
			);
		}
		const missing = provision(['agent-x', 'eng-agents', 'none', '--acts-for', 'nobody@example.com']);
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /does not exist/);
	});

	it('sets actsFor within one clearance, as before', () => {
		for (const [role, principal] of [
			['eng-agents', 'kris@example.com'],
			['eng-public', 'pat@example.com'],
		]) {
			const result = provision([`agent-${role}`, role, 'none', '--acts-for', principal]);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(
				result.operations.map((op) => op.operation),
				['list_users', 'add_user', 'upsert'],
			);
			assert.deepEqual(result.operations[2].records, [{ id: `user:agent-${role}`, actsFor: principal }]);
		}
	});
});

describe('deploy/deploy.sh staging', () => {
	it("ships the env dir's config, package, scripts and schema, and nothing else", () => {
		const stubs = clusterStubs();
		writeFileSync(
			join(stubs, 'npm'),
			[
				'#!/usr/bin/env bash',
				'case "$1" in',
				'  run) exit 0;;',
				'  pack) : >"$3/harperfast-agent-memory-0.0.0.tgz"; echo \'[{"filename":"harperfast-agent-memory-0.0.0.tgz"}]\';;',
				'esac',
				'',
			].join('\n'),
		);
		chmodSync(join(stubs, 'npm'), 0o755);
		const work = mkdtempSync(join(tmpdir(), 'deploy-stage-'));
		try {
			const log = join(work, 'ops.log');
			const result = run('deploy.sh', [join(deployDir, 'engineering')], {
				PATH: `${stubs}:${process.env.PATH}`,
				AGENT_MEMORY_DEPLOY_HOST: 'host.invalid',
				AGENT_MEMORY_CONTAINER_MATCH: 'match',
				STUB_LOG: log,
			});
			assert.equal(result.status, 0, result.stderr);
			const [op] = operationsLogged(log);
			assert.equal(op.operation, 'deploy_component');
			assert.equal(op.project, 'agent-memory-app');
			writeFileSync(join(work, 'app.tgz'), Buffer.from(op.payload, 'base64'));
			const listed = spawnSync('tar', ['-tzf', join(work, 'app.tgz')], { encoding: 'utf8' });
			const files = listed.stdout
				.split('\n')
				.map((name) => name.replace(/^\.\//, ''))
				.filter((name) => name && !name.endsWith('/'))
				.sort();
			assert.deepEqual(files, [
				'config.yaml',
				'package.json',
				'provision.js',
				'resources.js',
				'schema.graphql',
				'vendor/harperfast-agent-memory.tgz',
			]);
		} finally {
			rmSync(work, { recursive: true, force: true });
			rmSync(stubs, { recursive: true, force: true });
		}
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
