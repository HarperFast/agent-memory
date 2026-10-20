import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test } from 'harper';
import { normalizeError, notFound } from '../dist/errors.js';
import { getMemory, linkSupersedes, putMemory } from '../dist/lifecycle.js';
import { createPrincipal } from '../dist/scopes.js';
import { parseSearchParams, searchMemories } from '../dist/search.js';
import { applySettings, parseSettings } from '../dist/settings.js';
import { memoryCandidates } from '../dist/supersession.js';
import { createModelBackend } from '../scripts/lib/model-backend.mjs';
import { fingerprint, judgePair, parseDecisions, run } from '../scripts/backfill-supersession.mjs';

const root = createPrincipal({ id: 'root', superUser: true });
const alice = createPrincipal({ id: 'alice', grants: { read: ['global'], write: ['global'] } });
const ENV = { AGENT_MEMORY_USER: 'root', AGENT_MEMORY_PASS: 'secret' };
const idFor = (tag) => `mem-${tag}--`.padEnd(16, '_');
const stored = (id) => __test.stores.get('Memory').get(id);
const GREBE = 'grebe colony counted at forty pairs on the north lake';
let dir;
let server;
let target;
const requests = [];

// The plugin's own functions behind HTTP, as a super_user, the way the script reaches a real server.
async function handle(request, response) {
	let body = '';
	for await (const chunk of request) body += chunk;
	const url = new URL(request.url, 'http://localhost');
	requests.push({ method: request.method, path: url.pathname, ifMatch: request.headers['if-match'], body });
	const context = { headers: { 'if-match': request.headers['if-match'] } };
	const [, id, action] = url.pathname.split('/').filter(Boolean);
	let status = 200;
	let json;
	try {
		if (request.headers.authorization !== `Basic ${Buffer.from('root:secret').toString('base64')}`) {
			throw Object.assign(new Error('auth'), { statusCode: 401 });
		}
		if (!id) json = { memories: await searchMemories(parseSearchParams(url.searchParams), root, context) };
		else if (action === 'candidates') json = { candidates: await memoryCandidates(id, root, context) };
		else if (action === 'supersedes') json = { memory: await linkSupersedes(id, JSON.parse(body), root, context) };
		else {
			const memory = await getMemory(id, root, context);
			if (!memory) throw notFound();
			json = { memory };
		}
	} catch (error) {
		const safe =
			error.statusCode === 401
				? { statusCode: 401, message: 'auth', code: 'unauthorized' }
				: normalizeError(error, 'test');
		status = safe.statusCode;
		json = { error: safe.message, code: safe.code };
	}
	response.writeHead(status, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(json));
}

function capture() {
	let text = '';
	return {
		write: (chunk) => (text += chunk),
		get text() {
			return text;
		},
	};
}

async function cli(argv, env = ENV) {
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, env, { stdout, stderr });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

const create = async (tag, title, content, overrides = {}, principal = alice) => {
	await new Promise((resolve) => setTimeout(resolve, 2));
	return (await putMemory(idFor(tag), { title, content, visibility: 'shared', ...overrides }, principal, {})).memory;
};

// A three-version chain (each version REPLACES the last), a refinement, and an unrelated memory.
async function seed() {
	const a = await create('a', 'Grebe count v1', `${GREBE} in the first survey`);
	const citer = await create('citer', 'Lake plan', 'quarterly budget review for the finance meeting', {
		evidence: [{ kind: 'memory', ref: idFor('a') }],
	});
	const b = await create('b', 'Grebe count v2', `${GREBE} in the first survey REPLACES`);
	const c = await create('c', 'Grebe count v3', `${GREBE} in the first survey REPLACES again`);
	const e = await create('e', 'Grebe count note', `${GREBE} in the first survey EXTENDS`);
	await create('unrelated', 'Kernel tuning', 'kernel tuning guidance for disks');
	return { a, b, c, e, citer };
}

const reportPath = (name) => join(dir, name);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pairKey = (pair) => `${pair.newId}>${pair.oldId}`;
async function decide(report, path, approve) {
	const decisions = await readJson(report);
	for (const pair of decisions.pairs) pair.approve = approve.includes(pairKey(pair));
	await writeFile(path, JSON.stringify(decisions));
	return path;
}

before(async () => {
	dir = await mkdtemp(join(tmpdir(), 'backfill-'));
	server = createServer((request, response) => {
		handle(request, response).catch((error) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	target = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	server.close();
	await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
	__test.reset();
	applySettings(parseSettings({}));
	requests.length = 0;
});

describe('backfill-supersession report', () => {
	it('lists each judged (newer, older) pair with ids, titles and verdicts, never content, in a new 0600 file', async () => {
		const { a, b, c, e } = await seed();
		const path = reportPath('report-1.json');
		const result = await cli(['--target', target, '--report', path, '--judge', 'stub']);
		assert.equal(result.code, 0, result.stderr);
		assert.equal((await stat(path)).mode & 0o777, 0o600);

		const text = await readFile(path, 'utf8');
		const report = JSON.parse(text);
		assert.equal(report.format, 'agent-memory-supersession-backfill');
		assert.deepEqual(report.judge, { backend: 'stub', model: null });
		const byKey = new Map(report.pairs.map((pair) => [pairKey(pair), pair]));
		assert.deepEqual(
			[...byKey.keys()].sort(),
			[
				`${b.id}>${a.id}`,
				`${c.id}>${a.id}`,
				`${c.id}>${b.id}`,
				`${e.id}>${a.id}`,
				`${e.id}>${b.id}`,
				`${e.id}>${c.id}`,
			].sort(),
		);
		assert.deepEqual(Object.keys(byKey.get(`${c.id}>${b.id}`)).sort(), [
			'approve',
			'newCreatedAt',
			'newFingerprint',
			'newId',
			'newTitle',
			'oldCreatedAt',
			'oldFingerprint',
			'oldId',
			'oldTitle',
			'rationale',
			'similarity',
			'verdict',
		]);
		const pair = byKey.get(`${c.id}>${b.id}`);
		assert.equal(pair.newTitle, 'Grebe count v3');
		assert.equal(pair.oldTitle, 'Grebe count v2');
		assert.equal(pair.verdict, 'supersedes');
		assert.equal(pair.approve, false, 'nothing is approved until the operator says so');
		assert.equal(pair.newFingerprint, fingerprint(stored(c.id)));
		assert.equal(byKey.get(`${e.id}>${a.id}`).verdict, 'refines');
		assert.deepEqual(report.summary, {
			memories: 6,
			pairs: 6,
			verdicts: { supersedes: 3, refines: 3, unrelated: 0, failed: 0 },
		});

		assert.ok(!text.includes(GREBE), 'the report carries no memory content');
		for (const output of [result.stdout, result.stderr]) {
			assert.ok(!output.includes(GREBE) && !output.includes('Grebe count'), 'output carries no content or titles');
		}
		assert.equal(JSON.parse(result.stdout).pairs, 6);
		assert.ok(
			requests.every((request) => request.method === 'GET'),
			'a report writes nothing',
		);
	});

	it('refuses to overwrite a report and makes no judge call when the path exists', async () => {
		await seed();
		const path = reportPath('report-exists.json');
		await writeFile(path, 'keep');
		const result = await cli(['--target', target, '--report', path, '--judge', 'stub']);
		assert.equal(result.code, 2);
		assert.equal(await readFile(path, 'utf8'), 'keep');
		assert.equal(requests.length, 0);
	});

	it('writes no report when the judge fails on every pair', async () => {
		await seed();
		const path = reportPath('report-no-judge.json');
		const result = await cli(['--target', target, '--report', path, '--judge', 'anthropic'], ENV);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /the judge failed on every pair \(anthropic_no_api_key\)/);
		await assert.rejects(stat(path), { code: 'ENOENT' });
	});

	it('records a failed or malformed judgement as an unapproved pair with a code, never the reply', async () => {
		const older = { title: 'old', content: 'old text' };
		const newer = { title: 'new', content: 'new text' };
		const failing = createModelBackend('stub', {
			respond: () => {
				throw Object.assign(new Error('SECRET reply'), { code: 'cli_timeout' });
			},
		});
		assert.deepEqual(await judgePair(failing, newer, older), { verdict: null, rationale: null, error: 'cli_timeout' });
		const malformed = createModelBackend('stub', { respond: () => ({ verdict: 'replaces', rationale: 'x' }) });
		assert.deepEqual(await judgePair(malformed, newer, older), {
			verdict: null,
			rationale: null,
			error: 'judge_invalid_answer',
		});
		const chatty = createModelBackend('stub', {
			respond: () => ({ verdict: 'refines', rationale: 'First sentence. Second sentence with more.' }),
		});
		assert.deepEqual(await judgePair(chatty, newer, older), { verdict: 'refines', rationale: 'First sentence.' });
	});
});

describe('backfill-supersession --apply', () => {
	async function reported() {
		const memories = await seed();
		const path = reportPath(`report-${Math.random().toString(36).slice(2)}.json`);
		const result = await cli(['--target', target, '--report', path, '--judge', 'stub']);
		assert.equal(result.code, 0, result.stderr);
		requests.length = 0;
		return { ...memories, report: path };
	}
	const posts = () => requests.filter((request) => request.method === 'POST');

	it('applies only approved supersedes pairs, newest replacement first, so a chain resolves through each link', async () => {
		const { a, b, c, e, citer, report } = await reported();
		const decisions = await decide(report, reportPath('decisions-chain.json'), [
			`${b.id}>${a.id}`,
			`${c.id}>${b.id}`,
			`${e.id}>${a.id}`,
		]);
		const result = await cli(['--target', target, '--apply', decisions]);
		assert.equal(result.code, 0, result.stderr);
		const outcome = JSON.parse(result.stdout);
		assert.equal(outcome.approved, 2);
		assert.equal(outcome.ignored, 1, 'an approved refines pair is not applied');
		assert.equal(outcome.linked, 2);
		assert.deepEqual(
			posts().map((request) => [request.path, JSON.parse(request.body).ids]),
			[
				[`/Memory/${c.id}/supersedes`, [b.id]],
				[`/Memory/${b.id}/supersedes`, [a.id]],
			],
		);
		assert.equal(stored(a.id).status, 'superseded');
		assert.equal(stored(a.id).supersededBy, b.id);
		assert.equal(stored(b.id).supersededBy, c.id);
		assert.equal(stored(c.id).status, 'active');
		assert.equal(stored(citer.id).needsReview.sourceId, a.id);
		assert.equal(stored(e.id).status, 'active');
	});

	it('points every superseded memory and its review flags at the latest replacement when all links are approved', async () => {
		const { a, b, c, citer, report } = await reported();
		const decisions = await decide(report, reportPath('decisions-all.json'), [
			`${b.id}>${a.id}`,
			`${c.id}>${b.id}`,
			`${c.id}>${a.id}`,
		]);
		const result = await cli(['--target', target, '--apply', decisions]);
		assert.equal(JSON.parse(result.stdout).linked, 3);
		assert.equal(stored(a.id).supersededBy, c.id);
		assert.equal(stored(b.id).supersededBy, c.id);
		assert.equal(stored(citer.id).needsReview.replacementId, c.id);
		assert.deepEqual([...stored(b.id).supersedes], [a.id]);
	});

	it('is idempotent: a second run links nothing and reports the pairs as already linked', async () => {
		const { a, b, c, report } = await reported();
		const decisions = await decide(report, reportPath('decisions-rerun.json'), [`${b.id}>${a.id}`, `${c.id}>${b.id}`]);
		await cli(['--target', target, '--apply', decisions]);
		requests.length = 0;
		const revisions = [a, b, c].map((memory) => stored(memory.id).revision);
		const again = await cli(['--target', target, '--apply', decisions]);
		assert.equal(again.code, 0);
		const outcome = JSON.parse(again.stdout);
		assert.equal(outcome.linked, 0);
		assert.equal(outcome.alreadyLinked, 2);
		assert.equal(posts().length, 0);
		assert.deepEqual(
			[a, b, c].map((memory) => stored(memory.id).revision),
			revisions,
		);
	});

	it('skips a pair whose memory changed since it was judged', async () => {
		const { a, b, report } = await reported();
		const decisions = await decide(report, reportPath('decisions-changed.json'), [`${b.id}>${a.id}`]);
		await putMemory(a.id, { content: `${GREBE} corrected later` }, alice, { headers: { 'if-match': '"1"' } });
		const outcome = JSON.parse((await cli(['--target', target, '--apply', decisions])).stdout);
		assert.deepEqual(outcome.skipped, { changed: 1, missing: 0, withdrawn: 0 });
		assert.equal(posts().length, 0);
		assert.equal(stored(a.id).status, 'active');
	});

	it('reports a refused link as failed with the server code, and carries on with the rest', async () => {
		const { a, b, c, report } = await reported();
		const decisions = await decide(report, reportPath('decisions-refused.json'), [
			`${b.id}>${a.id}`,
			`${c.id}>${b.id}`,
		]);
		// A narrowing makes C unable to replace B.
		await putMemory(b.id, { scopes: ['global', 'team:y'] }, root, { headers: { 'if-match': '"1"' } });
		const result = await cli(['--target', target, '--apply', decisions]);
		assert.equal(result.code, 1);
		const outcome = JSON.parse(result.stdout);
		assert.equal(outcome.linked, 1);
		assert.deepEqual(outcome.failed, [{ newId: c.id, oldId: b.id, status: 403, code: 'supersede_scope_narrowing' }]);
	});

	it('validates the whole decisions file before writing anything', async () => {
		const { a, b, report } = await reported();
		const decisions = await readJson(report);
		for (const pair of decisions.pairs) pair.approve = pairKey(pair) === `${b.id}>${a.id}`;
		decisions.pairs.at(-1).approve = 'yes';
		const path = reportPath('decisions-bad.json');
		await writeFile(path, JSON.stringify(decisions));
		const result = await cli(['--target', target, '--apply', path]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /pair \d+ is malformed/);
		assert.equal(requests.length, 0);
		assert.throws(() => parseDecisions({ format: 'other', version: 1, pairs: [] }), /not a version 1/);
	});
});

describe('backfill-supersession usage', () => {
	it('requires a target, exactly one mode, a known judge and a safe URL', async () => {
		for (const argv of [
			['--report', 'r.json'],
			['--target', 'http://127.0.0.1:1'],
			['--target', 'http://127.0.0.1:1', '--report', 'r.json', '--apply', 'd.json'],
			['--target', 'http://127.0.0.1:1', '--report', 'r.json', '--judge', 'gpt'],
			['--target', 'http://127.0.0.1:1', '--report', 'r.json', '--concurrency', '0'],
			['--target', 'http://example.com', '--report', 'r.json'],
			['--target', 'http://127.0.0.1:1', '--bogus'],
		]) {
			assert.equal((await cli(argv)).code, 2, argv.join(' '));
		}
		assert.equal((await cli(['--target', 'http://127.0.0.1:1', '--report', 'r.json'], {})).code, 2, 'credentials');
	});
});
