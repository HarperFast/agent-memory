#!/usr/bin/env node
import { isMainModule, resolveConfig } from '../lib/config.mjs';

function buildMcpHeaders(env = process.env) {
	const config = resolveConfig(env);
	if (!config.authorization) return {};
	return { Authorization: config.authorization };
}

if (isMainModule(import.meta.url)) {
	try {
		process.stdout.write(JSON.stringify(buildMcpHeaders(process.env)) + '\n');
	} catch {
		process.stdout.write('{}\n');
	}
}
