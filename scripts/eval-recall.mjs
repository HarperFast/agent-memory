#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
	DEFAULT_RECALL_LIMIT,
	DEFAULT_RECALL_TIMEOUT_MS,
	formatAuthorizationHeader,
	isMainModule,
	resolveConfig,
	validateBaseUrl,
} from '../claude-plugin/lib/config.mjs';
import { truncatePrompt } from '../claude-plugin/lib/hooks.mjs';

export function parseDatasetJsonl(content) {
	const rows = [];
	const lines = String(content ?? '').split(/\r?\n/);
	for (let idx = 0; idx < lines.length; idx += 1) {
		const line = lines[idx].trim();
		if (!line || line.startsWith('#')) continue;
		const parsed = JSON.parse(line);
		if (!parsed || typeof parsed.prompt !== 'string' || !Array.isArray(parsed.expectedIds)) {
			throw new Error(`Invalid JSONL entry on line ${idx + 1}: expected { prompt: string, expectedIds: string[] }`);
		}
		rows.push({
			prompt: parsed.prompt,
			expectedIds: parsed.expectedIds.map(String),
		});
	}
	return rows;
}

export function computeRecallAtK(returnedIds, expectedIds, k) {
	const expected = Array.isArray(expectedIds) ? expectedIds : [];
	if (expected.length === 0) return 1;
	const topK = new Set((Array.isArray(returnedIds) ? returnedIds : []).slice(0, k));
	let hits = 0;
	for (const id of new Set(expected)) {
		if (topK.has(id)) hits += 1;
	}
	return hits / new Set(expected).size;
}

export function computeLatencyStats(latenciesMs) {
	if (!Array.isArray(latenciesMs) || latenciesMs.length === 0) {
		return { min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
	}
	const sorted = [...latenciesMs].sort((a, b) => a - b);
	const pickPercentile = (p) => {
		const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
		return Number(sorted[idx].toFixed(2));
	};
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	return {
		min: Number(sorted[0].toFixed(2)),
		p50: pickPercentile(50),
		p95: pickPercentile(95),
		max: Number(sorted[sorted.length - 1].toFixed(2)),
		mean: Number((sum / sorted.length).toFixed(2)),
	};
}

function parseEvalArgs(argv) {
	const options = {
		datasetPath: undefined,
		k: undefined,
		timeoutMs: undefined,
		url: undefined,
		token: undefined,
		watch: true,
		json: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--json') {
			options.json = true;
		} else if (arg === '--no-watch') {
			options.watch = false;
		} else if (arg === '--watch') {
			options.watch = true;
		} else if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (arg === '--dataset' || arg === '-d' || arg === '-f') {
			if (argv[i + 1]) options.datasetPath = argv[++i];
		} else if (arg === '--k' || arg === '-k' || arg === '--limit') {
			if (argv[i + 1]) options.k = Number.parseInt(argv[++i], 10);
		} else if (arg === '--timeout-ms' || arg === '--timeout') {
			if (argv[i + 1]) options.timeoutMs = Number.parseInt(argv[++i], 10);
		} else if (arg === '--url') {
			if (argv[i + 1]) options.url = argv[++i];
		} else if (arg === '--token') {
			if (argv[i + 1]) options.token = argv[++i];
		} else if (!arg.startsWith('-') && !options.datasetPath) {
			options.datasetPath = arg;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

export async function evaluateRecallDataset(rows, { baseUrl, authorization, k, timeoutMs, watch = true, fetchImpl }) {
	const results = [];
	const latencies = [];
	let timeouts = 0;
	let errors = 0;

	for (const row of rows) {
		const query = truncatePrompt(row.prompt);
		const watchParam = watch ? '&watch=true' : '';
		const url = `${baseUrl}/Memory/?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(k)}${watchParam}`;
		const start = performance.now();
		let returnedIds = [];
		let timedOut = false;
		let errorMsg;

		try {
			const response = await fetchImpl(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					Authorization: authorization,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (!response.ok) {
				await response.text();
				errors += 1;
				errorMsg = `HTTP ${response.status}`;
			} else {
				const body = await response.json();
				if (Array.isArray(body?.memories)) {
					returnedIds = body.memories.map((m) => String(m?.id ?? '')).filter(Boolean);
				}
			}
			const elapsed = Number((performance.now() - start).toFixed(2));
			latencies.push(elapsed);

			const recall = computeRecallAtK(returnedIds, row.expectedIds, k);
			results.push({
				prompt: row.prompt,
				expectedIds: row.expectedIds,
				returnedIds: returnedIds.slice(0, k),
				recallAtK: Number(recall.toFixed(4)),
				latencyMs: elapsed,
				timedOut: false,
				...(errorMsg ? { error: errorMsg } : {}),
			});
		} catch (error) {
			const elapsed = Number((performance.now() - start).toFixed(2));
			latencies.push(elapsed);
			if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
				timedOut = true;
				timeouts += 1;
			} else {
				errors += 1;
			}
			results.push({
				prompt: row.prompt,
				expectedIds: row.expectedIds,
				returnedIds: [],
				recallAtK: 0,
				latencyMs: elapsed,
				timedOut,
				error: error?.message ?? String(error),
			});
		}
	}

	const count = results.length;
	const meanRecall = count > 0 ? Number((results.reduce((acc, r) => acc + r.recallAtK, 0) / count).toFixed(4)) : 0;
	const hitCount = results.filter((r) => r.recallAtK > 0).length;
	const hitRate = count > 0 ? Number((hitCount / count).toFixed(4)) : 0;
	const timeoutRate = count > 0 ? Number((timeouts / count).toFixed(4)) : 0;
	const latencyMs = computeLatencyStats(latencies);

	return {
		k,
		count,
		watch,
		recallAtK: meanRecall,
		hitRate,
		timeouts,
		timeoutRate,
		errors,
		latencyMs,
		results,
	};
}

export async function runEval(argv = [], env = process.env, io = {}) {
	const stdout = io.stdout ?? ((msg) => process.stdout.write(msg + '\n'));
	const stderr = io.stderr ?? ((msg) => process.stderr.write(msg + '\n'));
	const fetchImpl = io.fetchImpl ?? globalThis.fetch;

	const args = parseEvalArgs(argv);
	if (args.help) {
		stdout(
			'Usage: eval-recall.mjs [--dataset <file.jsonl>] [--k <limit>] [--timeout-ms <ms>] [--url <url>] [--token <token>] [--watch | --no-watch] [--json]',
		);
		return { exitCode: 0 };
	}

	if (!args.datasetPath) {
		stderr('Error: specify a JSONL dataset file via --dataset <path> or positional argument.');
		return { exitCode: 1 };
	}

	const config = resolveConfig(env);
	const baseUrl = args.url ? validateBaseUrl(args.url, env.AGENT_MEMORY_ALLOW_INSECURE_HTTP === '1') : config.baseUrl;
	const authorization = args.token ? formatAuthorizationHeader(args.token) : config.authorization;
	const k = Number.isInteger(args.k) && args.k > 0 ? args.k : (config.recallLimit ?? DEFAULT_RECALL_LIMIT);
	const timeoutMs =
		Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
			? args.timeoutMs
			: (config.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS);

	if (!baseUrl || !authorization) {
		stderr('Error: AGENT_MEMORY_URL and AGENT_MEMORY_TOKEN (or --url and --token) are required.');
		return { exitCode: 1 };
	}

	const rawContent = readFileSync(args.datasetPath, 'utf8');
	const rows = parseDatasetJsonl(rawContent);
	const summary = await evaluateRecallDataset(rows, {
		baseUrl,
		authorization,
		k,
		timeoutMs,
		watch: args.watch,
		fetchImpl,
	});

	if (args.json) {
		stdout(JSON.stringify(summary, null, 2));
	} else {
		stdout(
			`Recall@${summary.k} over ${summary.count} queries (watch=${summary.watch}): ${(summary.recallAtK * 100).toFixed(1)}% (hit rate: ${(summary.hitRate * 100).toFixed(1)}%, timeouts: ${summary.timeouts}/${summary.count})`,
		);
		stdout(
			`Latency (ms): min=${summary.latencyMs.min} p50=${summary.latencyMs.p50} p95=${summary.latencyMs.p95} max=${summary.latencyMs.max} mean=${summary.latencyMs.mean}`,
		);
	}

	return { exitCode: 0, summary };
}

if (isMainModule(import.meta.url)) {
	runEval(process.argv.slice(2), process.env).then(
		({ exitCode }) => process.exit(exitCode),
		(error) => {
			process.stderr.write(`Error: ${error?.message ?? error}\n`);
			process.exit(1);
		},
	);
}
