#!/usr/bin/env node
// Installs a packed (non-symlinked) copy of the plugin into each integration fixture: Harper's module loader
// refuses a `file:` symlink that resolves outside the app's allowed path.
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(repoRoot, 'integrationTests', 'fixtures');

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status})`);
}

run('npm', ['run', 'build'], repoRoot);

const packDir = mkdtempSync(join(tmpdir(), 'agent-memory-fixture-pack-'));
try {
	const pack = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: repoRoot, encoding: 'utf8' });
	if (pack.status !== 0) throw new Error(`npm pack failed (exit ${pack.status}): ${pack.stderr}`);
	const tarball = join(packDir, JSON.parse(pack.stdout)[0].filename);
	for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const fixturePath = join(fixturesDir, entry.name);
		rmSync(join(fixturePath, 'node_modules'), { recursive: true, force: true });
		rmSync(join(fixturePath, 'package-lock.json'), { force: true });
		run('npm', ['install', '--no-save', '--ignore-scripts', '--legacy-peer-deps', tarball], fixturePath);
	}
} finally {
	rmSync(packDir, { recursive: true, force: true });
}
