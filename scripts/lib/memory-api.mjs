// HTTP helpers shared by the operator scripts. Errors carry statuses and codes only: a response body can be memory
// content.
import { ERROR_CODE, failureCode } from './cli.mjs';

export const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 60_000;
// An import batch embeds up to 100 rows before it commits.
const IMPORT_TIMEOUT_MS = 300_000;
const READ_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const IMPORT_RESULTS = new Set(['created', 'unchanged', 'conflict']);

export function createClient(target, authorization) {
	return async (method, path, { body, headers } = {}) => {
		let response;
		try {
			response = await fetch(`${target}/${path}`, {
				method,
				headers: {
					Authorization: authorization,
					Accept: 'application/json',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: 'error',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			return { status: 0, code: failureCode(error) };
		}
		let json;
		try {
			json = await response.json();
		} catch {
			// A parse error message would quote the body, which can be memory content.
			json = undefined;
		}
		return { status: response.status, json, code: failureCode(json) };
	};
}

export function requestError(what, result) {
	return new Error(`${what} failed: ${result.status ? `HTTP ${result.status}` : 'no response'} (${result.code})`);
}

export const pause = (attempt) => new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));

// A 503 is the server asking for a retry: an index catching up, a lock not granted in time.
export async function readWithRetry(request, path) {
	for (let attempt = 1; ; attempt++) {
		const result = await request('GET', path);
		if ((result.status !== 503 && result.status !== 0) || attempt === READ_ATTEMPTS) return result;
		await pause(attempt);
	}
}

/**
 * Every memory the caller can list, oldest first, one page at a time. With `includeWithdrawn` the server must
 * acknowledge the parameter: a server that predates it ignores it and would silently leave withdrawn rows out.
 */
export async function* memoryPages(request, { includeWithdrawn = false } = {}) {
	const query = `order=created&limit=${PAGE_SIZE}&includeSuperseded=true&includeExpired=true${
		includeWithdrawn ? '&includeWithdrawn=true' : ''
	}`;
	let after = '';
	for (;;) {
		const result = await readWithRetry(request, `Memory/?${query}${after}`);
		if (result.status !== 200 || !Array.isArray(result.json?.memories)) throw requestError('listing memories', result);
		if (includeWithdrawn && result.json.includeWithdrawn !== true) {
			throw new Error('listing memories failed: the server does not list withdrawn memories (upgrade it)');
		}
		const page = result.json.memories;
		yield page;
		if (page.length < PAGE_SIZE) return;
		const last = page.at(-1);
		const next = `&after=${encodeURIComponent(`${last.createdAt},${last.id}`)}`;
		if (next === after) throw new Error('listing memories failed: the cursor did not advance');
		after = next;
	}
}

async function errorDetail(response, rows) {
	try {
		const body = await response.json();
		const parts = [];
		if (typeof body?.code === 'string' && ERROR_CODE.test(body.code)) parts.push(`code ${body.code}`);
		if (Number.isInteger(body?.index) && rows[body.index]) {
			parts.push(`row ${body.index} (${rows[body.index].id})`);
		}
		return parts.length ? `, ${parts.join(', ')}` : '';
	} catch {
		return '';
	}
}

/**
 * Sends rows to `POST /Memory/import` in order, `batchSize` at a time. Every batch commits whole or not at all, so a
 * failure reports how far the run got and a re-run resumes.
 */
export async function postBatches(rows, { target, authorization, batchSize, stderr, label = 'batch' }) {
	const url = `${target}/Memory/import`;
	const result = { created: 0, unchanged: 0, conflict: 0, conflicts: [], dependsOnConflict: [] };
	const conflictIds = new Set();
	const batchCount = Math.ceil(rows.length / batchSize);
	const failBatch = (batch, detail, cause) => {
		const error = new Error(
			`${label} ${batch}/${batchCount} failed: ${detail}; earlier batches are committed and a re-run resumes`,
			cause ? { cause } : undefined,
		);
		if (batch > 1) error.partialResult = result;
		return error;
	};
	for (let start = 0, batch = 1; start < rows.length; start += batchSize, batch++) {
		const batchRows = rows.slice(start, start + batchSize);
		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({ rows: batchRows }),
				redirect: 'error',
				signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
			});
		} catch (error) {
			throw failBatch(batch, failureCode(error), error);
		}
		if (!response.ok) {
			throw failBatch(batch, `HTTP ${response.status}${await errorDetail(response, batchRows)}`);
		}
		let body;
		try {
			body = await response.json();
		} catch (error) {
			if (error?.name !== 'SyntaxError') throw failBatch(batch, failureCode(error), error);
			body = null;
		}
		const results = body?.results;
		if (
			!Array.isArray(results) ||
			results.length !== batchRows.length ||
			!results.every((entry, index) => entry?.id === batchRows[index].id && IMPORT_RESULTS.has(entry.result))
		) {
			throw failBatch(batch, 'response does not carry one result per row in order');
		}
		results.forEach((entry) => {
			result[entry.result]++;
			if (entry.result === 'conflict') {
				conflictIds.add(entry.id);
				result.conflicts.push({ id: entry.id });
			}
		});
		// Successors come first, so a conflicted successor is already known when its predecessor's result arrives.
		results.forEach((entry, index) => {
			const { id, supersededBy } = batchRows[index];
			if (entry.result !== 'conflict' && conflictIds.has(supersededBy)) {
				result.dependsOnConflict.push({ id, supersededBy });
			}
		});
		stderr.write(`${label} ${batch}/${batchCount}: ${batchRows.length} rows\n`);
	}
	return result;
}
