#!/usr/bin/env node
import { resolveConfig } from '../lib/config.mjs';

export function buildMcpHeaders(env = process.env) {
	const config = resolveConfig(env);
	if (!config.authorization) return {};
	return { Authorization: config.authorization };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		process.stdout.write(JSON.stringify(buildMcpHeaders(process.env)) + '\n');
	} catch {
		process.stdout.write('{}\n');
	}
}
