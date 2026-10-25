#!/usr/bin/env node
// Installs a packed (non-symlinked) copy of the plugin into each integration fixture: Harper's module loader
// refuses a `file:` symlink that resolves outside the app's allowed path. Pass a tarball path to install that
// exact package (the release job tests the tarball it publishes); otherwise this packs the checkout.
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(repoRoot, 'integrationTests', 'fixtures');

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 120_000 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (exit ${result.status})`);
}

const packDir = process.argv[2] ? undefined : mkdtempSync(join(tmpdir(), 'agent-memory-fixture-pack-'));
try {
	let tarball;
	if (packDir) {
		run('npm', ['pack', '--pack-destination', packDir], repoRoot);
		tarball = join(packDir, readdirSync(packDir)[0]);
	} else {
		tarball = resolve(process.argv[2]);
	}
	for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const fixturePath = join(fixturesDir, entry.name);
		rmSync(join(fixturePath, 'node_modules'), { recursive: true, force: true });
		rmSync(join(fixturePath, 'package-lock.json'), { force: true });
		run('npm', ['install', '--no-save', '--ignore-scripts', '--legacy-peer-deps', tarball], fixturePath);
	}
} finally {
	if (packDir) rmSync(packDir, { recursive: true, force: true });
}
