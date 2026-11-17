import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const DIAGNOSTICS_MAX_BYTES = 256 * 1024;
const ENTRY_FIELDS = [
	'event',
	'session',
	'outcome',
	'reason',
	'code',
	'ms',
	'hits',
	'injected',
	'notices',
	'stale',
	'stateError',
];
const CODE_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
// O_NONBLOCK: opening a planted FIFO fails instead of blocking the prompt.
const APPEND_FLAGS =
	constants.O_WRONLY |
	constants.O_APPEND |
	constants.O_CREAT |
	(constants.O_NOFOLLOW ?? 0) |
	(constants.O_NONBLOCK ?? 0);

export function getDiagnosticsPath(config) {
	return join(config.cacheDir, 'diagnostics.jsonl');
}

export function errorCode(error) {
	const code = error?.cause?.code ?? error?.code;
	return typeof code === 'string' && CODE_PATTERN.test(code) ? code : undefined;
}

function openForAppend(path) {
	const fd = openSync(path, APPEND_FLAGS, 0o600);
	if (fstatSync(fd).isFile()) return fd;
	closeSync(fd);
	return undefined;
}

export function recordDiagnostic(config, entry, maxBytes = DIAGNOSTICS_MAX_BYTES) {
	let fd;
	try {
		const line = { ts: new Date().toISOString() };
		for (const field of ENTRY_FIELDS) {
			if (entry[field] !== undefined) line[field] = entry[field];
		}
		const text = JSON.stringify(line) + '\n';
		const path = getDiagnosticsPath(config);
		mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
		fd = openForAppend(path);
		if (fd === undefined) return;
		const size = fstatSync(fd).size;
		if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
			closeSync(fd);
			fd = undefined;
			renameSync(path, `${path}.1`);
			fd = openForAppend(path);
			if (fd === undefined) return;
		}
		writeSync(fd, text);
	} catch {
		return;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

export function readDiagnostics(config) {
	const path = getDiagnosticsPath(config);
	const entries = [];
	for (const file of [`${path}.1`, path]) {
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n')) {
			try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed.outcome === 'string') entries.push(parsed);
			} catch {}
		}
	}
	return entries;
}

function percentile(sorted, fraction) {
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

export function summarizeDiagnostics(entries) {
	const summary = {};
	for (const entry of entries) {
		const event = (summary[entry.event ?? 'unknown'] ??= { count: 0, outcomes: {}, ms: [] });
		event.count++;
		const key = entry.reason ? `${entry.outcome}:${entry.reason}` : entry.outcome;
		event.outcomes[key] = (event.outcomes[key] ?? 0) + 1;
		if (typeof entry.ms === 'number') event.ms.push(entry.ms);
	}
	for (const event of Object.values(summary)) {
		const sorted = event.ms.sort((a, b) => a - b);
		event.ms = sorted.length
			? { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) }
			: undefined;
	}
	return summary;
}
