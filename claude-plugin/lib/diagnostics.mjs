import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;
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
// O_NOFOLLOW and O_NONBLOCK: a planted symlink or FIFO is refused instead of written through or waited on.
const SAFE_OPEN = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | SAFE_OPEN;
const READ_FLAGS = constants.O_RDONLY | SAFE_OPEN;

export function getDiagnosticsPath(config) {
	return join(config.cacheDir, 'diagnostics.jsonl');
}

export function errorCode(error) {
	const code = error?.cause?.code ?? error?.code;
	return typeof code === 'string' && CODE_PATTERN.test(code) ? code : undefined;
}

function openRegularFile(path, flags) {
	const fd = openSync(path, flags, 0o600);
	try {
		const stat = fstatSync(fd);
		if (stat.isFile()) return { fd, size: stat.size };
	} catch {}
	closeSync(fd);
	return undefined;
}

function openForAppend(config, path) {
	try {
		return openRegularFile(path, APPEND_FLAGS);
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
		mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
		return openRegularFile(path, APPEND_FLAGS);
	}
}

export function recordDiagnostic(config, entry, maxBytes = MAX_BYTES) {
	let file;
	try {
		const line = { ts: new Date().toISOString() };
		for (const field of ENTRY_FIELDS) {
			if (entry[field] !== undefined) line[field] = entry[field];
		}
		const text = JSON.stringify(line) + '\n';
		const path = getDiagnosticsPath(config);
		file = openForAppend(config, path);
		if (file && file.size > 0 && file.size + Buffer.byteLength(text) > maxBytes) {
			closeSync(file.fd);
			file = undefined;
			renameSync(path, `${path}.1`);
			file = openForAppend(config, path);
		}
		if (file) writeSync(file.fd, text);
	} catch {
		return;
	} finally {
		if (file) {
			try {
				closeSync(file.fd);
			} catch {}
		}
	}
}

// Something other than the writer may have grown the file past the cap.
function readRegularFile(path) {
	let file;
	try {
		file = openRegularFile(path, READ_FLAGS);
		if (!file) return '';
		const length = Math.min(file.size, MAX_BYTES);
		const buffer = Buffer.alloc(length);
		const read = readSync(file.fd, buffer, 0, length, file.size - length);
		return buffer.toString('utf8', 0, read);
	} catch {
		return '';
	} finally {
		if (file) closeSync(file.fd);
	}
}

export function readDiagnostics(config) {
	const path = getDiagnosticsPath(config);
	const entries = [];
	for (const text of [readRegularFile(`${path}.1`), readRegularFile(path)]) {
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
	const events = new Map();
	for (const entry of entries) {
		const name = String(entry.event ?? 'unknown');
		let event = events.get(name);
		if (!event) events.set(name, (event = { count: 0, outcomes: new Map(), ms: [] }));
		event.count++;
		const key = entry.reason ? `${entry.outcome}:${entry.reason}` : entry.outcome;
		event.outcomes.set(key, (event.outcomes.get(key) ?? 0) + 1);
		if (typeof entry.ms === 'number') event.ms.push(entry.ms);
	}
	return Object.fromEntries(
		[...events].map(([name, { count, outcomes, ms }]) => {
			const sorted = ms.sort((a, b) => a - b);
			const latency = sorted.length
				? { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) }
				: undefined;
			return [name, { count, outcomes: Object.fromEntries(outcomes), ms: latency }];
		}),
	);
}
