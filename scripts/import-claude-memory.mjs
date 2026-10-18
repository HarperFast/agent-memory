#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { formatAuthorizationHeader, resolveConfig, validateBaseUrl } from '../claude-plugin/lib/config.mjs';

const DEFAULT_SCOPE = 'user:<self>';
const TITLE_MAX_CHARS = 200;
const CONTENT_MAX_CHARS = 50_000;

export function extractBasicUsername(authorization) {
	if (!authorization || !/^Basic\s+/i.test(authorization)) return undefined;
	try {
		const b64 = authorization.replace(/^Basic\s+/i, '').trim();
		const decoded = Buffer.from(b64, 'base64').toString('utf8');
		const colon = decoded.indexOf(':');
		if (colon > 0) return decoded.slice(0, colon);
	} catch {
		return undefined;
	}
	return undefined;
}

export function deriveMemoryId(name, principalNamespace = DEFAULT_SCOPE) {
	const key = `${String(principalNamespace).trim().toLowerCase()}\0${String(name).trim().toLowerCase()}`;
	const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
	return `cm_${digest}`;
}

export function sanitizeTag(rawType) {
	const cleaned = String(rawType ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._:-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!cleaned) return undefined;
	return `type:${cleaned}`.slice(0, 64);
}

export function parseFrontmatterDocument(rawText, fallbackName = 'memory') {
	const text = String(rawText ?? '').replace(/\r\n/g, '\n');
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return {
			hasFrontmatter: false,
			name: fallbackName,
			description: '',
			type: undefined,
			body: text.trim(),
		};
	}

	const fmLines = match[1].split('\n');
	const body = match[2].trim();
	const fields = {};
	for (const rawLine of fmLines) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	return {
		hasFrontmatter: true,
		name: fields.name || fallbackName,
		description: fields.description || '',
		type: fields.type || undefined,
		body,
	};
}

export function extractWikiLinks(text) {
	const links = [];
	const seen = new Set();
	const regex = /\[\[([^[\]|#]+)(?:[|#][^\]]*)?\]\]/g;
	let match;
	while ((match = regex.exec(String(text ?? ''))) !== null) {
		const target = match[1].trim();
		if (!target) continue;
		const lower = target.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			links.push(target);
		}
	}
	return links;
}

export function collectMarkdownFiles(paths) {
	const files = [];
	const seen = new Set();
	for (const rawPath of paths) {
		const abs = resolve(rawPath);
		let stat;
		try {
			stat = statSync(abs);
		} catch {
			throw new Error(`Path not found: ${rawPath}`);
		}
		if (stat.isDirectory()) {
			const entries = readdirSync(abs).sort();
			for (const entry of entries) {
				if (extname(entry).toLowerCase() !== '.md') continue;
				if (entry.toUpperCase() === 'MEMORY.MD') continue;
				const full = join(abs, entry);
				if (!seen.has(full) && statSync(full).isFile()) {
					seen.add(full);
					files.push(full);
				}
			}
		} else if (stat.isFile()) {
			if (!seen.has(abs)) {
				seen.add(abs);
				files.push(abs);
			}
		}
	}
	return files;
}

export function buildImportPlan(fileEntries, options = {}) {
	const scope = options.scope || DEFAULT_SCOPE;
	const principalKey = options.principalKey || scope;
	const excludeTypes = new Set((options.excludeTypes ?? []).map((t) => String(t).trim().toLowerCase()));

	const parsedDocs = [];
	for (const entry of fileEntries) {
		const filePath = entry.filePath;
		const stem = basename(filePath, extname(filePath));
		const parsed = parseFrontmatterDocument(entry.content, stem);
		if (basename(filePath).toUpperCase() === 'MEMORY.MD' && !parsed.type) {
			continue;
		}
		if (parsed.type && excludeTypes.has(parsed.type.toLowerCase())) {
			continue;
		}
		if (!parsed.body && !parsed.description) {
			continue;
		}
		const id = deriveMemoryId(parsed.name || stem, principalKey);
		parsedDocs.push({
			filePath,
			stem,
			id,
			name: parsed.name || stem,
			description: parsed.description,
			type: parsed.type,
			body: parsed.body,
		});
	}

	const nameToId = new Map();
	for (const doc of parsedDocs) {
		nameToId.set(doc.name.trim().toLowerCase(), doc.id);
		nameToId.set(doc.stem.trim().toLowerCase(), doc.id);
	}

	const records = parsedDocs.map((doc) => {
		const tags = [];
		const typeTag = doc.type ? sanitizeTag(doc.type) : undefined;
		if (typeTag) tags.push(typeTag);

		const rawTitle = doc.description ? `${doc.name} — ${doc.description}` : doc.name;
		const title = rawTitle.slice(0, TITLE_MAX_CHARS);
		const content = (doc.body || doc.description || doc.name).slice(0, CONTENT_MAX_CHARS);

		const wikiTargets = extractWikiLinks(`${doc.description}\n${doc.body}`);
		const evidence = [];
		const citedIds = [];
		const seenRefs = new Set();
		for (const target of wikiTargets) {
			const targetId = nameToId.get(target.toLowerCase());
			if (targetId && targetId !== doc.id && !seenRefs.has(targetId)) {
				seenRefs.add(targetId);
				evidence.push({ kind: 'memory', ref: targetId });
				citedIds.push(targetId);
			}
		}

		return {
			id: doc.id,
			filePath: doc.filePath,
			name: doc.name,
			title,
			content,
			tags,
			scopes: [scope],
			evidence,
			citedIds,
		};
	});

	const ordered = topologicalOrder(records);
	return ordered;
}

function topologicalOrder(records) {
	const byId = new Map(records.map((r) => [r.id, r]));
	const visited = new Set();
	const visiting = new Set();
	const result = [];

	const visit = (record) => {
		if (visited.has(record.id)) return;
		if (visiting.has(record.id)) return;
		visiting.add(record.id);
		for (const depId of record.citedIds) {
			const dep = byId.get(depId);
			if (dep && !visited.has(dep.id)) {
				visit(dep);
			}
		}
		visiting.delete(record.id);
		visited.add(record.id);
		result.push(record);
	};

	for (const record of records) {
		visit(record);
	}
	return result;
}

async function putRecord(baseUrl, authorization, record, includeEvidence, fetchImpl) {
	const scope = record.scopes?.[0] ?? DEFAULT_SCOPE;
	const payload = {
		title: record.title,
		content: record.content,
		tags: record.tags,
		evidence: includeEvidence ? record.evidence : [],
	};
	if (scope === DEFAULT_SCOPE) {
		payload.visibility = 'private';
	} else {
		payload.scopes = record.scopes;
	}

	const url = `${baseUrl}/Memory/${encodeURIComponent(record.id)}`;
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		Authorization: authorization,
	};

	let response = await fetchImpl(url, {
		method: 'PUT',
		headers,
		body: JSON.stringify(payload),
		redirect: 'error',
	});

	if (response.status === 409 || response.status === 412) {
		const getRes = await fetchImpl(url, {
			method: 'GET',
			headers: { Accept: 'application/json', Authorization: authorization },
			redirect: 'error',
		});
		if (getRes.ok) {
			const existing = await getRes.json();
			const rev = existing?.memory?.revision ?? existing?.revision;
			if (typeof rev === 'number') {
				response = await fetchImpl(url, {
					method: 'PUT',
					headers: { ...headers, 'If-Match': `"${rev}"` },
					body: JSON.stringify(payload),
					redirect: 'error',
				});
			}
		}
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to PUT ${record.id} (${response.status}): ${text}`);
	}
	const body = await response.json();
	return body?.revision ?? body?.memory?.revision ?? 1;
}

async function reviseRecordEvidence(baseUrl, authorization, record, revision, fetchImpl) {
	const scope = record.scopes?.[0] ?? DEFAULT_SCOPE;
	const payload = {
		title: record.title,
		content: record.content,
		tags: record.tags,
		evidence: record.evidence,
	};
	if (scope === DEFAULT_SCOPE) {
		payload.visibility = 'private';
	} else {
		payload.scopes = record.scopes;
	}

	const url = `${baseUrl}/Memory/${encodeURIComponent(record.id)}`;
	const response = await fetchImpl(url, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Authorization: authorization,
			'If-Match': `"${revision}"`,
		},
		body: JSON.stringify(payload),
		redirect: 'error',
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Failed to update evidence on ${record.id} (${response.status}): ${text}`);
	}
	const body = await response.json();
	return body?.revision ?? body?.memory?.revision ?? revision + 1;
}

export function parseArgs(argv) {
	const options = {
		paths: [],
		dryRun: false,
		scope: DEFAULT_SCOPE,
		url: undefined,
		token: undefined,
		user: undefined,
		deleteMigrated: false,
		archiveDir: undefined,
		excludeTypes: [],
		json: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run' || arg === '-n') {
			options.dryRun = true;
		} else if (arg === '--json') {
			options.json = true;
		} else if (arg === '--delete-migrated') {
			options.deleteMigrated = true;
		} else if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (arg === '--dir' || arg === '-d') {
			if (argv[i + 1]) options.paths.push(argv[++i]);
		} else if (arg === '--scope') {
			if (argv[i + 1]) options.scope = argv[++i];
		} else if (arg === '--url') {
			if (argv[i + 1]) options.url = argv[++i];
		} else if (arg === '--token') {
			if (argv[i + 1]) options.token = argv[++i];
		} else if (arg === '--user') {
			if (argv[i + 1]) options.user = argv[++i];
		} else if (arg === '--archive-dir') {
			if (argv[i + 1]) options.archiveDir = argv[++i];
		} else if (arg === '--exclude-type') {
			if (argv[i + 1]) options.excludeTypes.push(argv[++i]);
		} else if (!arg.startsWith('-')) {
			options.paths.push(arg);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

export async function runImport(argv = [], env = process.env, io = {}) {
	const stdout = io.stdout ?? ((msg) => process.stdout.write(msg + '\n'));
	const stderr = io.stderr ?? ((msg) => process.stderr.write(msg + '\n'));
	const fetchImpl = io.fetchImpl ?? globalThis.fetch;

	const args = parseArgs(argv);
	if (args.help) {
		stdout(
			'Usage: import-claude-memory.mjs [--dry-run] [--scope <scope>] [--url <url>] [--token <token>] [--delete-migrated | --archive-dir <dir>] <file-or-dir...>',
		);
		return { exitCode: 0, records: [] };
	}

	if (args.paths.length === 0) {
		stderr('Error: specify at least one memory file or directory to import.');
		return { exitCode: 1, records: [] };
	}

	const config = resolveConfig(env);
	const baseUrl = args.url ? validateBaseUrl(args.url, env.AGENT_MEMORY_ALLOW_INSECURE_HTTP === '1') : config.baseUrl;
	const authorization = args.token ? formatAuthorizationHeader(args.token) : config.authorization;
	const inferredUser =
		args.user ||
		config.userId ||
		extractBasicUsername(authorization) ||
		(authorization ? createHash('sha256').update(authorization).digest('hex').slice(0, 12) : undefined);

	const principalKey =
		args.scope !== DEFAULT_SCOPE ? args.scope : inferredUser ? `user:${inferredUser}` : DEFAULT_SCOPE;

	const files = collectMarkdownFiles(args.paths);
	const fileEntries = files.map((filePath) => ({
		filePath,
		content: readFileSync(filePath, 'utf8'),
	}));

	const plan = buildImportPlan(fileEntries, {
		scope: args.scope,
		principalKey,
		excludeTypes: args.excludeTypes,
	});

	if (args.dryRun) {
		if (args.json) {
			stdout(JSON.stringify({ dryRun: true, count: plan.length, records: plan }, null, 2));
		} else {
			stdout(`Dry run: ${plan.length} memory file(s) planned for import (scope: ${args.scope}).`);
			for (const rec of plan) {
				const tagsStr = rec.tags.length > 0 ? ` tags=[${rec.tags.join(',')}]` : '';
				const evStr = rec.evidence.length > 0 ? ` evidence=${JSON.stringify(rec.evidence)}` : '';
				stdout(`  ${rec.id} <- ${basename(rec.filePath)} (${rec.title})${tagsStr}${evStr}`);
			}
		}
		return { exitCode: 0, records: plan };
	}

	if (!baseUrl || !authorization) {
		stderr('Error: AGENT_MEMORY_URL and AGENT_MEMORY_TOKEN (or --url and --token) are required for live import.');
		return { exitCode: 1, records: plan };
	}

	const writtenIds = new Set();
	const revisions = new Map();
	const needsSecondPass = [];

	for (const record of plan) {
		const allTargetsReady = record.citedIds.every((id) => writtenIds.has(id));
		const rev = await putRecord(baseUrl, authorization, record, allTargetsReady, fetchImpl);
		writtenIds.add(record.id);
		revisions.set(record.id, rev);
		if (!allTargetsReady && record.evidence.length > 0) {
			needsSecondPass.push(record);
		}
	}

	for (const record of needsSecondPass) {
		const rev = revisions.get(record.id) ?? 1;
		const nextRev = await reviseRecordEvidence(baseUrl, authorization, record, rev, fetchImpl);
		revisions.set(record.id, nextRev);
	}

	if (args.archiveDir) {
		const archiveAbs = resolve(args.archiveDir);
		mkdirSync(archiveAbs, { recursive: true });
		for (const record of plan) {
			renameSync(record.filePath, join(archiveAbs, basename(record.filePath)));
		}
	} else if (args.deleteMigrated) {
		for (const record of plan) {
			unlinkSync(record.filePath);
		}
	}

	if (args.json) {
		stdout(JSON.stringify({ dryRun: false, count: plan.length, records: plan }, null, 2));
	} else {
		stdout(`Imported ${plan.length} memory file(s) into ${baseUrl}.`);
		if (!args.deleteMigrated && !args.archiveDir && plan.length > 0) {
			stdout(
				'Note: remove or archive migrated files from ~/.claude/projects/.../memory/ (or pass --delete-migrated / --archive-dir) so the same facts are not loaded from both stores.',
			);
		}
	}

	return { exitCode: 0, records: plan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runImport(process.argv.slice(2), process.env).then(
		({ exitCode }) => process.exit(exitCode),
		(error) => {
			process.stderr.write(`Error: ${error?.message ?? error}\n`);
			process.exit(1);
		},
	);
}
