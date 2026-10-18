#!/usr/bin/env node
import { handleHookEvent } from '../lib/hooks.mjs';

const MAX_STDIN_BYTES = 256 * 1024;
const STDIN_TIMEOUT_MS = 500;

let exited = false;
function safeExitZero(payload = {}) {
	if (exited) return;
	exited = true;
	try {
		process.stdout.write(JSON.stringify(payload) + '\n', () => {
			process.exit(0);
		});
		setTimeout(() => process.exit(0), 25).unref();
	} catch {
		process.exit(0);
	}
}

process.on('uncaughtException', () => safeExitZero({}));
process.on('unhandledRejection', () => safeExitZero({}));
process.stdout.on('error', () => process.exit(0));

export function readBoundedStdin(stream = process.stdin, maxBytes = MAX_STDIN_BYTES, timeoutMs = STDIN_TIMEOUT_MS) {
	return new Promise((resolve) => {
		if (stream.isTTY) {
			resolve('');
			return;
		}
		const chunks = [];
		let total = 0;
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Buffer.concat(chunks).toString('utf8'));
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref?.();

		stream.on('data', (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			const remaining = maxBytes - total;
			if (remaining > 0) {
				chunks.push(buf.subarray(0, remaining));
				total += Math.min(buf.length, remaining);
			}
			if (total >= maxBytes) {
				finish();
			}
		});
		stream.on('end', finish);
		stream.on('error', finish);
	});
}

async function main() {
	const raw = await readBoundedStdin();
	let input = {};
	if (raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				input = parsed;
			}
		} catch {
			safeExitZero({});
			return;
		}
	}
	try {
		const output = await handleHookEvent(input, { env: process.env });
		safeExitZero(output ?? {});
	} catch {
		safeExitZero({});
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
