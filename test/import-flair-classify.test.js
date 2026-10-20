import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classificationCandidates, memoryIdFor, parseJsonl, parsePrincipalMap, run } from '../scripts/import-flair.mjs';
import {
	buildReport,
	classifyCandidates,
	CLASSIFY_SCHEMA,
	lessonIdFor,
	parseOrgMap,
	readDecisions,
	slugify,
} from '../scripts/lib/customer-content.mjs';

const FIXTURE = new URL('./fixtures/flair-customer-memories.jsonl', import.meta.url).pathname;
const PRINCIPAL_MAP = new URL('./fixtures/principal-map.json', import.meta.url).pathname;
const ORG_MAP = new URL('./fixtures/org-map.json', import.meta.url).pathname;
const flairRows = parseJsonl(await readFile(FIXTURE, 'utf8'));
const principalMap = parsePrincipalMap(JSON.parse(await readFile(PRINCIPAL_MAP, 'utf8')));
const STUB_ORGANIZATIONS = ['Zentrix Labs', 'Orbweaver Freight', 'A/B Corp', 'A B Corp'];
const DEFAULT_LESSON = {
	title: 'Compaction stalls under write bursts',
	content: 'When compaction falls behind, raise the compaction thread count.',
};
const FORBIDDEN = /SECRET|Zentrix Labs|Orbweaver Freight|A\/B Corp|Names a customer|Compaction stalls/;

const id = (flairId) => memoryIdFor(flairId);

function stubBackend({ delayMs = 0 } = {}) {
	const backend = {
		name: 'stub',
		calls: [],
		inFlight: 0,
		maxInFlight: 0,
		async complete({ system, prompt, schema }) {
			backend.calls.push({ system, prompt, schema });
			backend.inFlight++;
			backend.maxInFlight = Math.max(backend.maxInFlight, backend.inFlight);
			try {
				if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
				if (prompt.includes('FAIL-CLASSIFIER')) throw new Error('stub failure');
				if (prompt.includes('GARBLED')) return { verdict: 'maybe' };
				if (schema === CLASSIFY_SCHEMA) {
					const organizations = STUB_ORGANIZATIONS.filter((name) => prompt.includes(name));
					if (organizations.length) {
						return { customerSpecific: true, organizations, rationale: 'Names a customer deployment. More detail.' };
					}
					if (prompt.includes('STICKY'))
						return { customerSpecific: true, organizations: [], rationale: 'Still specific.' };
					return { customerSpecific: false, organizations: [], rationale: 'General Harper knowledge.' };
				}
				if (prompt.includes('LEAKY-LESSON')) return { title: 'Index rebuilds', content: 'Zentrix rebuilt its index.' };
				if (prompt.includes('STICKY-LESSON')) return { title: 'Large blobs', content: 'STICKY upload limit.' };
				return DEFAULT_LESSON;
			} finally {
				backend.inFlight--;
			}
		},
	};
	return backend;
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

async function cli(argv, { env = {}, backend } = {}) {
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, env, { stdout, stderr, backend });
	return { code, stdout: stdout.text, stderr: stderr.text };
}

async function stubServer(handler) {
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const entry = { method: request.method, url: request.url, body };
		requests.push(entry);
		const { status = 200, json } = await handler(entry);
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify(json));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function targetHandler({ resultFor = () => 'created', statusFor = () => 'active' } = {}) {
	return ({ method, url, body }) => {
		if (method === 'POST') {
			const { rows } = JSON.parse(body);
			return { json: { results: rows.map((row) => ({ id: row.id, result: resultFor(row) })) } };
		}
		const status = statusFor(url.slice('/Memory/'.length));
		return status ? { json: { memory: { status } } } : { status: 404, json: { error: 'not found' } };
	};
}

const TARGET_ENV = { AGENT_MEMORY_USER: 'importer', AGENT_MEMORY_PASS: 'target-secret' };
const SOURCE = ['--from-jsonl', FIXTURE, '--principal-map', PRINCIPAL_MAP];

describe('import-flair --classify', () => {
	let directory;
	let report;
	let result;
	let backend;
	const rowOf = (flairId) => report.rows.find((row) => row.id === id(flairId));

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), 'import-flair-classify-'));
		backend = stubBackend({ delayMs: 2 });
		const reportPath = join(directory, 'report.json');
		result = await cli(
			[...SOURCE, '--classify', '--lessons', '--org-map', ORG_MAP, '--report', reportPath, '--concurrency', '2'],
			{ backend },
		);
		report = JSON.parse(await readFile(reportPath, 'utf8'));
	});
	after(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it('labels customer-specific rows customer:<slug> through the org map and leaves the rest global', () => {
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(rowOf('c01').scopes, ['customer:zentrix']);
		assert.deepEqual(
			rowOf('c01').organizations.map(({ slug, source }) => ({ slug, source })),
			[
				{ slug: 'zentrix', source: 'map' },
				{ slug: 'zentrix', source: 'map' },
			],
			'the model name and the literal alias both resolve through the map',
		);
		assert.deepEqual(rowOf('c02').scopes, ['global']);
		assert.deepEqual(rowOf('c11').scopes, ['global']);
		assert.equal(rowOf('c01').rationale, 'Names a customer deployment.', 'one sentence only');
		assert.equal(rowOf('c01').title.startsWith('SECRET-c01 Zentrix Labs'), true);
		assert.equal(rowOf('c01').flairId, 'c01');
	});

	it('proposes organizations missing from the map as new slugs and lists them for review', () => {
		assert.deepEqual(rowOf('c04').scopes, ['customer:orbweaver-freight']);
		assert.deepEqual(report.newOrganizations, [
			{ slug: 'orbweaver-freight', names: ['Orbweaver Freight'], rows: [id('c04'), id('c08')] },
		]);
	});

	it('quarantines generated slugs that two different names share', () => {
		assert.equal(slugify('A/B Corp'), slugify('A B Corp'));
		assert.deepEqual(rowOf('c15').scopes, ['customer:unclassified']);
		assert.deepEqual(rowOf('c16').scopes, ['customer:unclassified']);
		assert.deepEqual(report.slugCollisions, [
			{ slug: 'a-b-corp', names: ['A/B Corp', 'A B Corp'], rows: [id('c15'), id('c16')], mappedAliases: [] },
		]);
	});

	it('fails closed to customer:unclassified when the classifier errors or answers outside its schema', () => {
		assert.deepEqual(rowOf('c05').scopes, ['customer:unclassified']);
		assert.equal(rowOf('c05').failure, 'classifier_error');
		assert.deepEqual(rowOf('c06').scopes, ['customer:unclassified']);
		assert.equal(rowOf('c06').failure, 'invalid_answer');
	});

	it('never classifies or reports private rows', () => {
		assert.equal(rowOf('c03'), undefined);
		assert.ok(!backend.calls.some((call) => call.prompt.includes('SECRET-c03')));
		assert.equal(report.rows.length, 15);
	});

	it('resolves supersession against the classified scopes', () => {
		assert.equal(rowOf('c09').status, 'superseded', 'customer successor of a customer record keeps the link');
		assert.equal(rowOf('c11').status, 'active', 'a customer successor would hide a global memory');
		assert.deepEqual(JSON.parse(result.stdout).summary.supersedes.unresolved, [
			{ from: 'c12', to: 'c11', reason: 'narrowing' },
		]);
	});

	it('drafts global lessons only for active, unexpired customer rows, with deterministic ids', () => {
		assert.deepEqual(rowOf('c01').lesson, { id: lessonIdFor(id('c01')), ...DEFAULT_LESSON });
		assert.equal(rowOf('c02').lesson, null, 'global rows need no lesson');
		assert.equal(rowOf('c09').lesson, null, 'superseded');
		assert.equal(rowOf('c13').lesson, null, 'withdrawn');
		assert.equal(rowOf('c14').lesson, null, 'expired');
		assert.ok(rowOf('c10').lesson);
		assert.equal(lessonIdFor(id('c01')), lessonIdFor(id('c01')));
		assert.notEqual(lessonIdFor(id('c01')), id('c01'));
	});

	it('drops and reports a lesson that names an organization or that the re-check still finds customer-specific', () => {
		assert.equal(rowOf('c07').lesson, null);
		assert.equal(rowOf('c07').droppedLesson.reason, 'mentions_organization');
		assert.equal(rowOf('c08').lesson, null);
		assert.equal(rowOf('c08').droppedLesson.reason, 'recheck_customer_specific');
		assert.equal(rowOf('c05').droppedLesson.reason, 'drafter_error');
		assert.equal(rowOf('c06').droppedLesson.reason, 'invalid_answer');
		const recheck = backend.calls.filter(
			(call) => call.schema === CLASSIFY_SCHEMA && call.prompt.includes('STICKY upload'),
		);
		assert.equal(recheck.length, 1, 'the draft goes back through the classifier');
		const { lessons } = JSON.parse(result.stdout).classification;
		assert.deepEqual(
			lessons.dropped.map(({ id: rowId, reason }) => [rowId, reason]).sort(),
			[
				[id('c05'), 'drafter_error'],
				[id('c06'), 'invalid_answer'],
				[id('c07'), 'mentions_organization'],
				[id('c08'), 'recheck_customer_specific'],
			].sort(),
		);
	});

	it('prints counts, ids and labels only, never memory content, names, rationales or lessons', () => {
		assert.doesNotMatch(result.stdout + result.stderr, FORBIDDEN);
		const output = JSON.parse(result.stdout);
		assert.equal(output.dryRun, true);
		assert.deepEqual(
			{ ...output.classification, failures: undefined, lessons: undefined },
			{
				classified: 15,
				global: 2,
				customer: 13,
				unclassified: 4,
				failures: undefined,
				newOrganizations: 1,
				slugCollisions: 1,
				lessons: undefined,
			},
		);
		assert.equal(output.classification.lessons.drafted, 6);
	});

	it('keeps every model call within --concurrency', () => {
		assert.ok(backend.maxInFlight <= 2, `max in flight ${backend.maxInFlight}`);
		assert.ok(backend.maxInFlight >= 2, 'calls do overlap');
	});

	it('writes the report 0600 and refuses to overwrite it, before any model call', async () => {
		const reportPath = join(directory, 'report.json');
		assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
		const again = stubBackend();
		const second = await cli([...SOURCE, '--classify', '--report', reportPath], { backend: again });
		assert.equal(second.code, 1);
		assert.match(second.stderr, /EEXIST/);
		assert.equal(again.calls.length, 0);
	});

	it('refuses an unwritable report directory before any model call', async () => {
		const again = stubBackend();
		const result = await cli([...SOURCE, '--classify', '--report', join(directory, 'missing', 'report.json')], {
			backend: again,
		});
		assert.equal(result.code, 1);
		assert.match(result.stderr, /cannot write --report: ENOENT/);
		assert.equal(again.calls.length, 0);
	});

	it('writes no report when the classifier fails on every row', async () => {
		const reportPath = join(directory, 'all-failed.json');
		const broken = {
			name: 'stub',
			complete: async () => {
				throw Object.assign(new Error('model backend failed: cli_not_found'), { code: 'cli_not_found' });
			},
		};
		const result = await cli([...SOURCE, '--classify', '--report', reportPath], { backend: broken });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /the classifier failed on every row \(cli_not_found\)/);
		await assert.rejects(stat(reportPath), { code: 'ENOENT' });
	});

	it('contacts no target: --classify refuses --target and needs no target credentials', async () => {
		const target = await stubServer(targetHandler());
		try {
			const refused = await cli(
				[...SOURCE, '--classify', '--report', join(directory, 'other.json'), '--target', target.url],
				{ env: TARGET_ENV, backend: stubBackend() },
			);
			assert.equal(refused.code, 2);
			assert.match(refused.stderr, /--classify only writes the report/);
			assert.equal(target.requests.length, 0);
		} finally {
			target.close();
		}
	});
});

describe('import-flair --decisions', () => {
	let directory;
	let report;

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), 'import-flair-decisions-'));
		const reportPath = join(directory, 'report.json');
		const proposal = await cli([...SOURCE, '--classify', '--lessons', '--org-map', ORG_MAP, '--report', reportPath], {
			backend: stubBackend(),
		});
		assert.equal(proposal.code, 0, proposal.stderr);
		report = JSON.parse(await readFile(reportPath, 'utf8'));
	});
	after(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function decisionsFile(name, edit) {
		const edited = structuredClone(report);
		edit(edited, (flairId) => edited.rows.find((row) => row.id === id(flairId)));
		const path = join(directory, name);
		await writeFile(path, JSON.stringify(edited));
		return path;
	}

	it('applies operator edits: changed scopes and slugs, an edited lesson, a removed lesson, an added lesson', async () => {
		const decisions = await decisionsFile('edited.json', (_edited, row) => {
			row('c02').scopes = ['customer:zentrix'];
			row('c04').scopes = ['customer:orbweaver'];
			row('c01').lesson.title = 'Operator-edited title';
			row('c10').lesson = null;
			row('c14').lesson = { title: 'Added by the operator', content: 'A reviewed lesson.' };
			row('c09').lesson = { title: 'Lesson from a superseded record', content: 'Not sent.' };
		});
		const target = await stubServer(
			targetHandler({ statusFor: (rowId) => (rowId === id('c04') ? 'withdrawn' : 'active') }),
		);
		const backend = stubBackend();
		try {
			const result = await cli([...SOURCE, '--decisions', decisions, '--target', target.url, '--batch-size', '5'], {
				env: TARGET_ENV,
				backend,
			});
			assert.equal(result.code, 0, result.stderr);
			assert.equal(backend.calls.length, 0, 'applying a report makes no model calls');
			assert.doesNotMatch(result.stdout + result.stderr, FORBIDDEN);

			const posts = target.requests.filter((request) => request.method === 'POST');
			const firstLessonBatch = posts.findIndex((request) => JSON.parse(request.body).rows.some((row) => row.evidence));
			const sources = posts.slice(0, firstLessonBatch).flatMap((request) => JSON.parse(request.body).rows);
			const lessons = posts.slice(firstLessonBatch).flatMap((request) => JSON.parse(request.body).rows);
			assert.equal(sources.length, 16, 'every source row is sent before the first lesson');
			assert.ok(
				lessons.every((row) => row.evidence),
				'no source row after a lesson',
			);
			const lastSourcePost = target.requests.indexOf(posts[firstLessonBatch - 1]);
			const gets = target.requests.filter((request) => request.method === 'GET');
			assert.ok(gets.every((request) => target.requests.indexOf(request) > lastSourcePost));

			const source = (flairId) => sources.find((row) => row.id === id(flairId));
			assert.deepEqual(source('c02').scopes, ['customer:zentrix']);
			assert.deepEqual(source('c04').scopes, ['customer:orbweaver']);
			assert.deepEqual(source('c03').scopes, ['user:ann'], 'private rows are untouched');
			assert.deepEqual(source('c11').scopes, ['global']);

			const c01 = lessons.find((row) => row.id === lessonIdFor(id('c01')));
			assert.deepEqual(c01, {
				id: lessonIdFor(id('c01')),
				ownerId: 'ann',
				title: 'Operator-edited title',
				content: DEFAULT_LESSON.content,
				scopes: ['global'],
				status: 'active',
				evidence: [{ kind: 'memory', ref: id('c01') }],
				createdAt: '2026-03-01T00:00:00.000Z',
			});
			const c14 = lessons.find((row) => row.id === lessonIdFor(id('c14')));
			assert.equal(c14.validUntil, '2026-04-01T00:00:00.000Z', 'a lesson expires with its source');
			assert.ok(!lessons.some((row) => row.id === lessonIdFor(id('c10'))), 'removed lesson is not sent');
			assert.ok(!lessons.some((row) => row.id === lessonIdFor(id('c04'))), 'withdrawn source gets no lesson');

			const output = JSON.parse(result.stdout);
			assert.deepEqual(output.lessons.skipped, [
				{ id: lessonIdFor(id('c09')), source: id('c09'), reason: 'source_not_active' },
				{ id: lessonIdFor(id('c04')), source: id('c04'), reason: 'source_not_active' },
			]);
			assert.ok(!gets.some((request) => request.url === `/Memory/${id('c09')}`), 'superseded here, so no GET');
			assert.equal(output.lessons.result.created, lessons.length);
		} finally {
			target.close();
		}
	});

	it('withholds a lesson whose source came back conflict, without asking the target about it', async () => {
		const decisions = await decisionsFile('as-proposed.json', () => {});
		const target = await stubServer(
			targetHandler({ resultFor: (row) => (row.id === id('c01') ? 'conflict' : 'created') }),
		);
		try {
			const result = await cli([...SOURCE, '--decisions', decisions, '--target', target.url], { env: TARGET_ENV });
			assert.equal(result.code, 0, result.stderr);
			const output = JSON.parse(result.stdout);
			assert.deepEqual(output.result.conflicts, [{ id: id('c01') }]);
			assert.deepEqual(
				output.lessons.skipped.filter((entry) => entry.source === id('c01')),
				[{ id: lessonIdFor(id('c01')), source: id('c01'), reason: 'source_conflict' }],
			);
			assert.ok(!target.requests.some((request) => request.url === `/Memory/${id('c01')}`));
		} finally {
			target.close();
		}
	});

	it('keeps the source results when the lesson phase fails', async () => {
		const decisions = await decisionsFile('lesson-fail.json', () => {});
		const target = await stubServer((request) =>
			request.method === 'POST' && JSON.parse(request.body).rows.some((row) => row.evidence)
				? { status: 500, json: {} }
				: targetHandler()(request),
		);
		try {
			const result = await cli([...SOURCE, '--decisions', decisions, '--target', target.url], { env: TARGET_ENV });
			assert.equal(result.code, 1);
			assert.match(result.stderr, /lesson batch 1\/1 failed: HTTP 500/);
			const output = JSON.parse(result.stdout);
			assert.equal(output.partial, true);
			assert.equal(output.result.created, 16);
			assert.deepEqual(output.lessons, { result: null });
		} finally {
			target.close();
		}
	});

	it('refuses a decisions file that is not a report, rather than importing everything as global', async () => {
		const target = await stubServer(targetHandler());
		try {
			for (const content of ['null', 'false', '0', '""']) {
				const decisions = join(directory, 'falsy.json');
				await writeFile(decisions, content);
				const result = await cli([...SOURCE, '--decisions', decisions, '--target', target.url], { env: TARGET_ENV });
				assert.equal(result.code, 1, content);
				assert.match(result.stderr, /version 1 classification report/);
			}
			assert.equal(target.requests.length, 0);
		} finally {
			target.close();
		}
	});

	it('refuses an empty --decisions value instead of importing everything as global', async () => {
		const target = await stubServer(targetHandler());
		try {
			const result = await cli([...SOURCE, '--decisions', '', '--target', target.url], { env: TARGET_ENV });
			assert.equal(result.code, 2);
			assert.match(result.stderr, /--decisions needs a value/);
			assert.equal(target.requests.length, 0);
		} finally {
			target.close();
		}
	});

	it('previews with --dry-run and sends nothing', async () => {
		const decisions = await decisionsFile('preview.json', () => {});
		const result = await cli([...SOURCE, '--decisions', decisions, '--dry-run']);
		assert.equal(result.code, 0, result.stderr);
		const output = JSON.parse(result.stdout);
		assert.equal(output.dryRun, true);
		assert.equal(output.lessons.toImport, 6);
		assert.equal(output.summary.byScope.global, 2);
	});

	it('refuses decisions that no longer match the source, before contacting the target', async () => {
		const decisions = await decisionsFile('stale.json', () => {});
		const changedSource = join(directory, 'changed.jsonl');
		const archived = flairRows.map((row) => (row.id === 'c02' ? { ...row, archived: true } : row));
		await writeFile(changedSource, archived.map((row) => JSON.stringify(row)).join('\n'));
		const target = await stubServer(targetHandler());
		try {
			const result = await cli(
				[
					'--from-jsonl',
					changedSource,
					'--principal-map',
					PRINCIPAL_MAP,
					'--decisions',
					decisions,
					'--target',
					target.url,
				],
				{ env: TARGET_ENV },
			);
			assert.equal(result.code, 1);
			assert.match(result.stderr, new RegExp(`decision ${id('c02')}: the source row changed since it was classified`));
			assert.equal(target.requests.length, 0);
			assert.doesNotMatch(result.stderr, FORBIDDEN);
		} finally {
			target.close();
		}
	});

	it('refuses missing, duplicate, unknown and out-of-policy decisions', async () => {
		const cases = [
			[(edited) => edited.rows.pop(), /no decision for 1 row\(s\)/],
			[(edited) => edited.rows.push(edited.rows[0]), /appears more than once/],
			[(edited) => (edited.rows[0].id = id('c03')), /names no row that would be classified/],
			[(_edited, row) => (row('c02').scopes = ['global', 'customer:zentrix']), /\["global"\] or customer:<slug>/],
			[(_edited, row) => (row('c02').scopes = ['team:core']), /\["global"\] or customer:<slug>/],
			[(_edited, row) => (row('c02').scopes = ['customer:Not A Slug']), /\["global"\] or customer:<slug>/],
			[(_edited, row) => (row('c01').lesson.id = 'x'.repeat(32)), /lesson.id is derived/],
			[(_edited, row) => (row('c01').lesson.content = ' '), /lesson is unusable \(no_lesson\)/],
			[(edited) => (edited.version = 2), /version 1 classification report/],
			[
				(_edited, row) => (row('c02').lesson = { title: 'A lesson', content: 'For a global row.' }),
				/a lesson applies only to a customer-labeled row/,
			],
			[
				(_edited, row) => (row('c01').lesson.content = 'What Zentrix Labs learned.'),
				/names an organization this row lists/,
			],
		];
		for (const [index, [edit, pattern]] of cases.entries()) {
			const decisions = await decisionsFile(`bad-${index}.json`, edit);
			const result = await cli([...SOURCE, '--decisions', decisions, '--dry-run']);
			assert.equal(result.code, 1, String(pattern));
			assert.match(result.stderr, pattern);
		}
	});
});

describe('customer-content helpers', () => {
	const candidate = (flairId, content) => ({
		id: id(flairId),
		flairId,
		ownerId: 'ann',
		content,
		tags: [],
		validUntil: null,
		fingerprint: 'f',
	});
	const answering = (respond) => ({ name: 'stub', complete: async ({ prompt }) => respond(prompt) });

	it('adds customer:unclassified when the model finds customer detail it cannot name, even beside an alias hit', async () => {
		const [entry] = await classifyCandidates([candidate('u1', 'Zentrix said the host was down')], {
			backend: answering(() => ({ customerSpecific: true, organizations: [], rationale: 'Unnamed party.' })),
			orgMap: parseOrgMap({ Zentrix: 'zentrix' }),
			concurrency: 1,
		});
		assert.deepEqual(entry.scopes, ['customer:unclassified', 'customer:zentrix']);
	});

	it('treats an answer with keys outside the schema as invalid, inherited names included', async () => {
		for (const extra of ['{"extra":1}', '{"constructor":1}', '{"__proto__":{}}', '{"toString":1}']) {
			const [entry] = await classifyCandidates([candidate('u2', 'note')], {
				backend: answering(() =>
					Object.assign(JSON.parse(extra), { customerSpecific: false, organizations: [], rationale: 'x' }),
				),
				orgMap: new Map(),
				concurrency: 1,
			});
			assert.deepEqual(entry.scopes, ['customer:unclassified'], extra);
			assert.equal(entry.failure, 'invalid_answer', extra);
		}
	});

	it('does not let an unusable name quarantine a valid one that shares its truncated slug', async () => {
		const entries = await classifyCandidates([candidate('u3', 'SHORT'), candidate('u4', 'LONG')], {
			backend: answering((prompt) => ({
				customerSpecific: true,
				organizations: [prompt.includes('LONG') ? 'A'.repeat(250) : 'A'.repeat(64)],
				rationale: 'x',
			})),
			orgMap: new Map(),
			concurrency: 1,
		});
		assert.deepEqual(entries[0].scopes, [`customer:${'a'.repeat(64)}`]);
		assert.equal(entries[1].organizations[0].source, 'unusable');
	});

	it('flags a generated slug that an org-map organization already uses', async () => {
		const entries = await classifyCandidates([candidate('u5', 'note')], {
			backend: answering(() => ({ customerSpecific: true, organizations: ['Zentrix!'], rationale: 'x' })),
			orgMap: parseOrgMap({ 'Zentrix Labs': 'zentrix' }),
			concurrency: 1,
		});
		assert.deepEqual(entries[0].scopes, ['customer:unclassified']);
		const report = buildReport(entries, { source: 'flair', classifier: 'stub', statusById: new Map() });
		assert.deepEqual(report.slugCollisions, [
			{ slug: 'zentrix', names: ['Zentrix!'], rows: [id('u5')], mappedAliases: ['zentrix labs'] },
		]);
	});

	it('binds a decision to every mapped source field, not only the content', () => {
		const [before] = classificationCandidates(flairRows.slice(0, 1), principalMap);
		for (const change of [{ archived: true }, { validTo: '2030-01-01T00:00:00.000Z' }, { agentId: 'agent-bob' }]) {
			const [after] = classificationCandidates([{ ...flairRows[0], ...change }], principalMap);
			assert.notEqual(after.fingerprint, before.fingerprint, JSON.stringify(change));
		}
		const candidates = classificationCandidates(flairRows, principalMap);
		assert.throws(
			() => readDecisions({ version: 1, rows: [] }, candidates, { maxContentChars: 100 }),
			/no decision for 15 row/,
		);
	});

	it('validates the org map without echoing aliases', () => {
		assert.throws(
			() => parseOrgMap({ 'Secret Org': 'Not A Slug' }),
			(error) => {
				assert.match(error.message, /entry #1/);
				assert.doesNotMatch(error.message, /Secret Org/);
				return true;
			},
		);
		assert.throws(() => parseOrgMap({ x: 'unclassified' }), /other than "unclassified"/);
		assert.throws(() => parseOrgMap({ Acme: 'acme', ACME: 'acme-2' }), /entry #2 repeats an alias/);
		assert.throws(() => parseOrgMap(['acme']), /JSON object/);
		assert.equal(parseOrgMap({ ' Acme   Corp ': 'acme' }).get('acme corp').slug, 'acme');
	});

	it('validates classification flags before reading anything', async () => {
		for (const [argv, pattern] of [
			[[...SOURCE, '--classify'], /--classify requires --report/],
			[[...SOURCE, '--classify', '--report', 'r', '--decisions', 'd'], /at most one of --classify or --decisions/],
			[[...SOURCE, '--dry-run', '--report', 'r'], /--report applies only to --classify/],
			[[...SOURCE, '--dry-run', '--org-map', ORG_MAP], /--org-map applies only to --classify/],
			[[...SOURCE, '--dry-run', '--lessons'], /--lessons applies only to --classify/],
			[[...SOURCE, '--classify', '--report', 'r', '--classifier', 'gpt'], /--classifier must be claude or anthropic/],
			[[...SOURCE, '--classify', '--report', 'r', '--concurrency', '0'], /--concurrency must be an integer/],
		]) {
			const result = await cli(argv, { backend: stubBackend() });
			assert.equal(result.code, 2, argv.join(' '));
			assert.match(result.stderr, pattern);
		}
	});
});
