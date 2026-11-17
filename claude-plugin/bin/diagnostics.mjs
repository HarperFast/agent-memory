#!/usr/bin/env node
import { isMainModule, resolveConfig } from '../lib/config.mjs';
import { getDiagnosticsPath, readDiagnostics, summarizeDiagnostics } from '../lib/diagnostics.mjs';

const USAGE = 'usage: diagnostics.mjs [--tail <n>] [--json]';

export function runDiagnostics(argv = [], env = process.env, write = (text) => process.stdout.write(text + '\n')) {
	let tail = 0;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--json') json = true;
		else if (argv[i] === '--tail' && /^\d+$/.test(argv[i + 1] ?? '')) tail = Number(argv[++i]);
		else {
			write(USAGE);
			return 2;
		}
	}
	const config = resolveConfig(env);
	const entries = readDiagnostics(config);
	const summary = summarizeDiagnostics(entries);
	const recent = tail > 0 ? entries.slice(-tail) : [];
	if (json) {
		write(JSON.stringify({ path: getDiagnosticsPath(config), entries: entries.length, summary, recent }));
		return 0;
	}
	write(`${getDiagnosticsPath(config)} (${entries.length} entries)`);
	for (const [event, { count, outcomes, ms }] of Object.entries(summary)) {
		write(`${event}: ${count}`);
		for (const [outcome, n] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) write(`  ${outcome}: ${n}`);
		if (ms) write(`  ms: p50 ${ms.p50}, p95 ${ms.p95}, max ${ms.max} (${ms.count} requests)`);
	}
	for (const entry of recent) write(JSON.stringify(entry));
	return 0;
}

if (isMainModule(import.meta.url)) {
	process.exitCode = runDiagnostics(process.argv.slice(2));
}
