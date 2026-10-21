// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { run as backfill } from '../scripts/backfill-supersession.mjs';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app');
const PASSWORD = 'Memory-test-1!';
const GREBE = 'grebe colony counted at forty pairs on the north lake';

suite('@harperfast/agent-memory supersession backfill over HTTP', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');
	let scratch: string;

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: basic(ctx.harper.admin.username, ctx.harper.admin.password),
			},
			body: JSON.stringify(body),
		});
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${await response.text()}`);
	}

	async function call(user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
		const authorization =
			user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
		const response = await fetch(`${ctx.harper.httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: authorization,
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	const get = async (id: string) => (await call('admin', 'GET', id)).body.memory;
	const create = async (user: string, tag: string, input: Record<string, unknown>) => {
		await new Promise((resolve) => setTimeout(resolve, 2));
		const response = await call(user, 'PUT', memId(tag), input);
		strictEqual(response.status, 201, JSON.stringify(response.body));
		return memId(tag);
	};
	const shared = (title: string, content: string, extra: object = {}) => ({
		title,
		content,
		visibility: 'shared',
		...extra,
	});
	const link = (user: string, id: string, ids: string[], revision: number, extra: object = {}) =>
		call(user, 'POST', `${id}/supersedes`, { ids, ...extra }, { 'If-Match': `"${revision}"` });
	const candidates = async (user: string, id: string) => call(user, 'GET', `${id}/candidates`);
	const importRows = async (rows: object[]) => {
		const response = await call('admin', 'POST', 'import', {
			rows: rows.map((row) => ({ ownerId: 'alice', scopes: ['global'], status: 'active', ...row })),
		});
		strictEqual(response.status, 200, JSON.stringify(response.body));
	};

	before(async () => {
		scratch = mkdtempSync(join(tmpdir(), 'backfill-it-'));
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['alice', 'bob', 'carol']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		// No grant at all: reads only its own private memories.
		await operation({ operation: 'add_role', role: 'outsider', permission: { super_user: false } });
		await operation({ operation: 'add_user', username: 'oscar', password: PASSWORD, role: 'outsider', active: true });
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				{ id: 'role:member', read: ['global'], write: ['global'] },
				{ id: 'user:bob', read: ['global', 'team:y'], write: ['global', 'team:y'] },
				{ id: 'user:carol', read: ['customer:x'], write: ['customer:x'] },
			],
		});
		const deadline = Date.now() + 60_000;
		let ready = await call('admin', 'GET', '?q=warmup');
		while (ready.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			ready = await call('admin', 'GET', '?q=warmup');
		}
		strictEqual(ready.status, 200, JSON.stringify(ready.body));
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(scratch, { recursive: true, force: true });
	});

	test('the created-order cursor walks exactly limit rows a page through a same-timestamp batch, readable rows only', async () => {
		const at = '2024-03-01T00:00:00.000Z';
		const rowId = (n: number) => `cursor-row-${String(n).padStart(2, '0')}`.padEnd(16, '_');
		await importRows([
			{ id: rowId(0), content: 'cursor first', createdAt: '2024-01-01T00:00:00.000Z' },
			...[6, 2, 4, 1, 5, 3].map((n) => ({ id: rowId(n), content: `cursor same ${n}`, createdAt: at })),
			{ id: rowId(7), content: 'cursor hidden', createdAt: at, scopes: ['customer:x'], ownerId: 'carol' },
			{ id: rowId(9), content: 'cursor last', createdAt: '2024-06-01T00:00:00.000Z' },
		]);
		const walk = async (user: string, limit: number) => {
			const seen: string[] = [];
			let after = '';
			for (;;) {
				const page = await call(user, 'GET', `?order=created&limit=${limit}${after}`);
				strictEqual(page.status, 200, JSON.stringify(page.body));
				ok(page.body.memories.length <= limit);
				seen.push(...page.body.memories.map((memory: any) => memory.id));
				if (page.body.memories.length < limit) return seen.filter((id) => id.startsWith('cursor-row-'));
				const last = page.body.memories.at(-1);
				after = `&after=${encodeURIComponent(`${last.createdAt},${last.id}`)}`;
			}
		};
		for (const limit of [1, 2, 4]) {
			deepStrictEqual(await walk('alice', limit), [0, 1, 2, 3, 4, 5, 6, 9].map(rowId), `limit ${limit}`);
		}
		deepStrictEqual(await walk('admin', 2), [0, 1, 2, 3, 4, 5, 6, 7, 9].map(rowId));
		strictEqual((await call('alice', 'GET', '?order=created&q=grebe')).status, 400);
		strictEqual((await call('alice', 'GET', `?after=${at},${rowId(1)}`)).status, 400);
	});

	test('candidates are the older, active, readable memories sharing a label above the threshold; unreadable ids 404 alike', async () => {
		const older = await create('alice', 'cand-older', shared('Grebe v1', `${GREBE} in the spring`));
		await create('bob', 'cand-narrow', shared('Grebe team', `${GREBE} in the summer`, { scopes: ['team:y'] }));
		await create('alice', 'cand-unrelated', shared('Kernel', 'kernel tuning guidance for disks'));
		const source = await create('alice', 'cand-source', shared('Grebe v2', `${GREBE} this year`));
		const newer = await create('alice', 'cand-newer', shared('Grebe v3', `${GREBE} next year`));

		const found = await candidates('alice', source);
		strictEqual(found.status, 200, JSON.stringify(found.body));
		deepStrictEqual(
			found.body.candidates.map((candidate: any) => candidate.id),
			[older],
		);
		ok(found.body.candidates[0].similarity >= 0.82);
		ok(
			(await candidates('alice', newer)).body.candidates.some((candidate: any) => candidate.id === source),
			'a newer memory proposes the older source',
		);
		strictEqual((await candidates('bob', source)).status, 403);
		const missing = await candidates('oscar', memId('cand-missing'));
		strictEqual(missing.status, 404);
		deepStrictEqual(await candidates('oscar', source), missing);
	});

	test('candidates order same-timestamp memories by id inside the query', async () => {
		const at = '2024-04-01T00:00:00.000Z';
		const peer = (n: number) => `tie-peer-${String(n).padStart(2, '0')}`.padEnd(16, '_');
		await importRows([
			{ id: 'tie-aaa-oldest___', content: `${GREBE} oldest tie`, createdAt: '2024-02-01T00:00:00.000Z' },
			...[...Array(8).keys()].map((n) => ({ id: peer(n), content: `${GREBE} tie ${n}`, createdAt: at })),
		]);
		const first = (await candidates('admin', peer(0))).body.candidates.map((candidate: any) => candidate.id);
		ok(first.includes('tie-aaa-oldest___'), JSON.stringify(first));
		ok(!first.some((id: string) => id.startsWith('tie-peer-')), 'no same-timestamp peer with a larger id');
	});

	test('a link supersedes and flags exactly as create-time supersede does', async () => {
		const scenario = async (prefix: string, linked: boolean) => {
			const source = await create(
				'alice',
				`${prefix}-src`,
				shared('Disk guidance', 'kernel tuning guidance for disks'),
			);
			const citer = await create(
				'bob',
				`${prefix}-cite`,
				shared('Conclusion', 'conclusion from the kernel guidance', { evidence: [{ kind: 'memory', ref: source }] }),
			);
			const input = shared('Disk guidance v2', 'kernel tuning guidance, corrected', {
				evidence: [{ kind: 'memory', ref: source }],
			});
			const replacement = linked
				? await create('alice', `${prefix}-new`, input)
				: await create('alice', `${prefix}-new`, { ...input, supersedes: [source] });
			if (linked) {
				const response = await link('alice', replacement, [source], 1);
				strictEqual(response.status, 200, JSON.stringify(response.body));
				deepStrictEqual(response.body.memory.supersedes, [source]);
			}
			const [s, c, r] = [await get(source), await get(citer), await get(replacement)];
			return {
				source: { status: s.status, replaced: s.supersededBy === replacement, revision: s.revision },
				citer: {
					...c.needsReview,
					since: undefined,
					sourceId: c.needsReview.sourceId === source,
					replacementId: c.needsReview.replacementId === replacement,
					revision: c.revision,
				},
				replacement: { needsReview: r.needsReview, supersedes: r.supersedes.length },
			};
		};
		deepStrictEqual(await scenario('lk', true), await scenario('cr', false));
	});

	test('a link enforces owner or super_user, readability, the scope superset, withdrawal and If-Match', async () => {
		const target = await create('alice', 'rule-target', shared('Rule target', `${GREBE} rule target`));
		const replacement = await create('alice', 'rule-new', shared('Rule new', `${GREBE} rule replacement`));
		strictEqual((await link('bob', replacement, [target], 1)).status, 403);
		const missing = await link('oscar', memId('rule-missing'), [target], 1);
		strictEqual(missing.status, 404);
		deepStrictEqual(await link('oscar', replacement, [target], 1), missing);

		const secret = await create(
			'carol',
			'rule-secret',
			shared('Secret', `${GREBE} secret`, { scopes: ['customer:x'] }),
		);
		const unreadable = await link('alice', replacement, [secret], 1);
		deepStrictEqual(unreadable, await link('alice', replacement, [memId('rule-missing')], 1));
		strictEqual(unreadable.status, 404);

		const wide = await create('bob', 'rule-wide', shared('Wide', `${GREBE} wide`, { scopes: ['global', 'team:y'] }));
		strictEqual((await link('admin', replacement, [wide], 1)).body.code, 'supersede_scope_narrowing');
		const retired = await create('alice', 'rule-retired', shared('Retired', `${GREBE} retired`));
		strictEqual((await call('alice', 'DELETE', retired, undefined, { 'If-Match': '"1"' })).status, 200);
		const withdrawn = await link('alice', replacement, [retired], 1);
		deepStrictEqual([withdrawn.status, withdrawn.body.code], [409, 'memory_withdrawn']);

		strictEqual((await call('alice', 'POST', `${replacement}/supersedes`, { ids: [target] })).status, 428);
		strictEqual((await link('alice', replacement, [target], 5)).status, 412);
		strictEqual((await link('alice', replacement, [target], 1, { revisions: { [target]: 9 } })).status, 412);
		strictEqual((await link('alice', replacement, [target], 1, { revisions: { [target]: 1 } })).status, 200);
		const old = await get(target);
		deepStrictEqual([old.status, old.supersededBy, old.revision], ['superseded', replacement, 2]);
	});

	test('a superseded memory can link an older one, and a cycle is refused', async () => {
		const a = await create('alice', 'chain-a', shared('Chain v1', `${GREBE} chain one`));
		const b = await create('alice', 'chain-b', shared('Chain v2', `${GREBE} chain two`));
		const c = await create('alice', 'chain-c', shared('Chain v3', `${GREBE} chain three`));
		strictEqual((await link('alice', c, [b], 1)).status, 200);
		strictEqual((await link('alice', b, [a], (await get(b)).revision)).status, 200);
		deepStrictEqual([(await get(a)).status, (await get(a)).supersededBy], ['superseded', b]);
		const cycle = await link('alice', a, [c], (await get(a)).revision);
		deepStrictEqual([cycle.status, cycle.body.code], [409, 'supersede_cycle']);
	});

	test('the backfill script reports judged pairs and applies only the approved ones, newest first, idempotently', async () => {
		const ids = {
			v1: await create(
				'alice',
				'bf-v1',
				shared('Heron v1', 'heron nests counted on the east marsh in the first survey'),
			),
			v2: await create(
				'alice',
				'bf-v2',
				shared('Heron v2', 'heron nests counted on the east marsh in the first survey REPLACES'),
			),
			v3: await create(
				'alice',
				'bf-v3',
				shared('Heron v3', 'heron nests counted on the east marsh in the first survey REPLACES again'),
			),
		};
		const env = { AGENT_MEMORY_USER: ctx.harper.admin.username, AGENT_MEMORY_PASS: ctx.harper.admin.password };
		const io = () => {
			let text = '';
			return { write: (chunk: string) => (text += chunk), text: () => text };
		};
		const runScript = async (argv: string[]) => {
			const stdout = io();
			const stderr = io();
			const code = await backfill(['--target', ctx.harper.httpURL, ...argv], env, { stdout, stderr } as any);
			return { code, stdout: stdout.text(), stderr: stderr.text() };
		};
		const reportFile = join(scratch, 'report.json');
		const reported = await runScript(['--report', reportFile, '--judge', 'stub']);
		strictEqual(reported.code, 0, reported.stderr);
		strictEqual(statSync(reportFile).mode & 0o777, 0o600);
		ok(!reported.stdout.includes('heron') && !reported.stderr.includes('heron'));
		const report = JSON.parse(readFileSync(reportFile, 'utf8'));
		ok(!JSON.stringify(report).includes('heron nests'), 'no content in the report');
		const key = (pair: any) => `${pair.newId}>${pair.oldId}`;
		// The test embedding is a hashed bag of words, so memories from other tests can be candidates too.
		const heronIds: string[] = Object.values(ids);
		const heron = report.pairs.filter((pair: any) => heronIds.includes(pair.newId) && heronIds.includes(pair.oldId));
		deepStrictEqual(
			heron.map(key).sort(),
			[`${ids.v2}>${ids.v1}`, `${ids.v3}>${ids.v1}`, `${ids.v3}>${ids.v2}`].sort(),
		);
		ok(heron.every((pair: any) => pair.verdict === 'supersedes' && pair.approve === false));

		for (const pair of report.pairs) pair.approve = [`${ids.v2}>${ids.v1}`, `${ids.v3}>${ids.v2}`].includes(key(pair));
		const decisions = join(scratch, 'decisions.json');
		writeFileSync(decisions, JSON.stringify(report));
		const applied = await runScript(['--apply', decisions]);
		strictEqual(applied.code, 0, applied.stderr);
		const outcome = JSON.parse(applied.stdout);
		deepStrictEqual([outcome.approved, outcome.linked, outcome.failed.length], [2, 2, 0]);
		deepStrictEqual([(await get(ids.v1)).supersededBy, (await get(ids.v2)).supersededBy], [ids.v2, ids.v3]);
		strictEqual((await get(ids.v3)).status, 'active');
		const searched = (await call('alice', 'GET', '?q=heron')).body.memories.map((memory: any) => memory.id);
		deepStrictEqual(
			searched.filter((id: string) => heronIds.includes(id)),
			[ids.v3],
			'default search shows only the latest version',
		);

		const again = JSON.parse((await runScript(['--apply', decisions])).stdout);
		deepStrictEqual([again.linked, again.alreadyLinked], [0, 2]);
		strictEqual((await runScript(['--report', reportFile, '--judge', 'stub'])).code, 2, 'never overwrites a report');
	});
});
