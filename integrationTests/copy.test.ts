// Needs `npm run install:fixtures` first: the fixture apps load the packed plugin from their own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type ContextWithHarper,
	type HarperTestContext,
} from '@harperfast/integration-testing';
import { run as copy, toImportRow } from '../scripts/copy-memories.mjs';

const require = createRequire(import.meta.url);
const PASSWORD = 'Memory-test-1!';
const NAMES = { zorblax: ['Zorblax Industries', 'Zorblax'] };
const FILLER = 55;

// Source: the customer-content fixture (patterns and a model check). Target: the plain fixture, which checks nothing,
// so a copy that dropped a flag would publish the row to every global reader.
suite('@harperfast/agent-memory copy between two instances', (ctx: ContextWithHarper) => {
	const targetCtx: HarperTestContext = createHarperContext('copy-target');
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const instances = () => ({ source: ctx.harper, target: targetCtx.harper! });
	const adminAuth = (which: 'source' | 'target') =>
		basic(instances()[which].admin!.username, instances()[which].admin!.password);
	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

	async function operation(which: 'source' | 'target', body: object) {
		const response = await fetch(instances()[which].operationsAPIURL!, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: adminAuth(which) },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${text}`);
	}

	async function call(
		which: 'source' | 'target',
		user: string,
		method: string,
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	) {
		const response = await fetch(`${instances()[which].httpURL}/Memory/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: user === 'admin' ? adminAuth(which) : basic(user, PASSWORD),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	async function put(user: string, tag: string, input: object, revision?: number) {
		await new Promise((resolve) => setTimeout(resolve, 2));
		const response = await call(
			'source',
			user,
			'PUT',
			memId(tag),
			input,
			revision ? { 'If-Match': `"${revision}"` } : {},
		);
		ok(
			response.status === 200 || response.status === 201,
			`PUT ${tag} → ${response.status} ${JSON.stringify(response.body)}`,
		);
		return response.body;
	}
	const shared = (content: string, extra: object = {}) => ({
		title: content.slice(0, 20),
		content,
		visibility: 'shared',
		...extra,
	});

	async function listAll(which: 'source' | 'target') {
		const memories: any[] = [];
		let after = '';
		for (;;) {
			const page = await call(
				which,
				'admin',
				'GET',
				`?order=created&limit=50&includeSuperseded=true&includeExpired=true&includeWithdrawn=true${after}`,
			);
			strictEqual(page.status, 200, JSON.stringify(page.body));
			strictEqual(page.body.includeWithdrawn, true);
			memories.push(...page.body.memories);
			if (page.body.memories.length < 50) return new Map(memories.map((memory) => [memory.id, memory]));
			const last = page.body.memories.at(-1);
			after = `&after=${encodeURIComponent(`${last.createdAt},${last.id}`)}`;
		}
	}

	async function runCopy(argv: string[]) {
		let stdout = '';
		let stderr = '';
		const code = await copy(
			argv,
			{ AGENT_MEMORY_FROM_AUTHORIZATION: adminAuth('source'), AGENT_MEMORY_TO_AUTHORIZATION: adminAuth('target') },
			{
				stdout: { write: (chunk: string) => (stdout += chunk) },
				stderr: { write: (chunk: string) => (stderr += chunk) },
			},
		);
		ok(!stdout.includes(adminAuth('source').slice(6)) && !stderr.includes(adminAuth('target').slice(6)));
		return { code, report: JSON.parse(stdout), stderr };
	}

	async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000) {
		const deadline = Date.now() + timeoutMs;
		let value = await read();
		while (!done(value)) {
			ok(Date.now() < deadline, `condition not reached; last value ${JSON.stringify(value)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
			value = await read();
		}
		return value;
	}

	before(async () => {
		const harperBinPath =
			process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
			join(dirname(require.resolve('harper')), 'bin', 'harper.js');
		const config = { logging: { stdStreams: true }, authentication: { authorizeLocal: false } };
		await Promise.all([
			setupHarperWithFixture(ctx, join(import.meta.dirname, 'fixtures', 'memory-app-content'), {
				harperBinPath,
				config,
				env: { AGENT_MEMORY_TEST_CUSTOMER_NAMES: JSON.stringify(NAMES) },
			}),
			setupHarperWithFixture(targetCtx, join(import.meta.dirname, 'fixtures', 'memory-app'), { harperBinPath, config }),
		]);
		for (const which of ['source', 'target'] as const) {
			await operation(which, { operation: 'add_role', role: 'member', permission: { super_user: false } });
			for (const username of ['alice', 'fleet', 'dave']) {
				await operation(which, { operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
			}
			await operation(which, {
				operation: 'upsert',
				database: 'memory',
				table: 'ScopeGrant',
				records: [
					{ id: 'role:member', read: ['global'], write: ['global'] },
					{ id: 'user:dave', read: ['customer:*'], write: ['customer:*'] },
				],
			});
			await eventually(
				() => call(which, 'admin', 'GET', '?q=warmup'),
				(ready) => ready.status !== 503,
				60_000,
			);
		}
	});

	after(async () => {
		await Promise.all([teardownHarper(ctx), teardownHarper(targetCtx)]);
	});

	test('copies every row with its history and quarantine, and a re-run reports every row unchanged', async () => {
		await put('alice', 'plain', shared('plain lesson about compaction'));
		const revised = await put('alice', 'revised', shared('first draft about vacuum'));
		await put('alice', 'revised', shared('second draft about vacuum'), revised.revision);
		await put('alice', 'chain-a', shared('chain lesson version one'));
		await put(
			'alice',
			'cites-a',
			shared('plan that relies on chain a', { evidence: [{ kind: 'memory', ref: memId('chain-a') }] }),
		);
		await put('alice', 'chain-b', shared('chain lesson version two', { supersedes: [memId('chain-a')] }));
		await put('alice', 'chain-c', shared('chain lesson version three', { supersedes: [memId('chain-b')] }));
		await put('alice', 'chain-d', shared('chain lesson sibling', { supersedes: [memId('chain-a')] }));
		// A review the owner already answered: a copy that stored chain-a before its replacement would raise it again.
		await put('alice', 'confirmed-h', shared('host sizing guidance'));
		await put(
			'alice',
			'cites-h',
			shared('budget that relies on h', { evidence: [{ kind: 'memory', ref: memId('confirmed-h') }] }),
		);
		await put('alice', 'replaces-h', shared('host sizing guidance revised', { supersedes: [memId('confirmed-h')] }));
		const flaggedCiter = await call('source', 'alice', 'GET', memId('cites-h'));
		ok(flaggedCiter.body.memory.needsReview);
		const confirmed = await call('source', 'alice', 'POST', `${memId('cites-h')}/confirm`, {});
		strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
		const gone = await put('alice', 'withdrawn', shared('obsolete runbook'));
		const withdrawn = await call('source', 'alice', 'DELETE', `${memId('withdrawn')}?reason=obsolete`, undefined, {
			'If-Match': `"${gone.revision}"`,
		});
		strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
		await put('alice', 'private', { title: 'private', content: 'alice private note', visibility: 'private' });
		await put('dave', 'customer', {
			title: 'customer',
			content: 'customer-scoped finding',
			scopes: ['customer:zorblax'],
		});
		await put('alice', 'pattern-flag', shared('Zorblax saw replication lag'));
		await put('alice', 'host-flag', shared('replica db1.zorbcloud.test fell behind'));
		await put('alice', 'model-flag', shared('incident write-up MODEL-SAYS-CUSTOMER'));
		await eventually(
			() => call('source', 'admin', 'GET', memId('model-flag')),
			(response) => response.body.memory?.contentFlag?.source === 'model',
		);
		await put('alice', 'expired', shared('temporary freeze notice', { validUntil: '2020-01-01T00:00:00.000Z' }));
		const filler = await call('source', 'admin', 'POST', 'import', {
			rows: Array.from({ length: FILLER }, (_, n) => ({
				id: memId(`filler-${n}`),
				ownerId: 'alice',
				content: `filler memory ${n}`,
				scopes: ['global'],
				status: 'active',
				createdAt: new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString(),
			})),
		});
		strictEqual(filler.status, 200, JSON.stringify(filler.body));

		const dryRun = await runCopy(['--from', ctx.harper.httpURL, '--to', targetCtx.harper!.httpURL!, '--dry-run']);
		strictEqual(dryRun.code, 0, dryRun.stderr);
		const sourceRows = await listAll('source');
		strictEqual(dryRun.report.source.memories, sourceRows.size);
		strictEqual(dryRun.report.source.byStatus.withdrawn, 1);
		strictEqual(dryRun.report.source.byScope['user:alice'], 1);
		strictEqual(dryRun.report.source.contentFlagged, 3);
		deepStrictEqual(sourceRows.get(memId('host-flag')).contentFlag.labels, ['zorb-host']);
		strictEqual((await listAll('target')).size, 0, 'a dry run writes nothing');

		const first = await runCopy([
			'--from',
			ctx.harper.httpURL,
			'--to',
			targetCtx.harper!.httpURL!,
			'--batch-size',
			'3',
		]);
		strictEqual(first.code, 0, `${first.stderr}\n${JSON.stringify(first.report)}`);
		strictEqual(first.report.imported.created, sourceRows.size);
		const targetRows = await listAll('target');
		deepStrictEqual([...targetRows.keys()].sort(), [...sourceRows.keys()].sort());
		for (const [id, memory] of sourceRows) {
			const copied = targetRows.get(id);
			deepStrictEqual(toImportRow(copied), toImportRow(memory), id);
			strictEqual(copied.revision, 1);
		}
		strictEqual(targetRows.get(memId('chain-a')).supersededBy, memId('chain-d'));
		strictEqual(targetRows.get(memId('cites-a')).needsReview.sourceId, memId('chain-a'));
		strictEqual(targetRows.get(memId('cites-h')).needsReview, null, 'an answered review is not raised again');

		// The target checks nothing, so only the carried flags keep these from global readers.
		for (const tag of ['pattern-flag', 'host-flag', 'model-flag']) {
			strictEqual((await call('target', 'fleet', 'GET', memId(tag))).status, 404, tag);
			strictEqual((await call('target', 'dave', 'GET', memId(tag))).status, 200, tag);
		}
		const fleetSearch = await call(
			'target',
			'fleet',
			'GET',
			'?q=Zorblax replication incident MODEL-SAYS-CUSTOMER&limit=50',
		);
		ok(
			!fleetSearch.body.memories.some(
				(memory: any) => memory.id.startsWith('mem-pattern') || memory.id.startsWith('mem-model'),
			),
		);
		strictEqual((await call('target', 'fleet', 'GET', memId('private'))).status, 404);
		strictEqual((await call('target', 'alice', 'GET', memId('private'))).status, 200);
		strictEqual((await call('target', 'fleet', 'GET', memId('customer'))).status, 404);

		const second = await runCopy(['--from', ctx.harper.httpURL, '--to', targetCtx.harper!.httpURL!]);
		strictEqual(second.code, 0, second.stderr);
		deepStrictEqual(
			{ created: second.report.imported.created, unchanged: second.report.imported.unchanged },
			{ created: 0, unchanged: sourceRows.size },
		);
	});

	test('includeWithdrawn is super_user only; other callers list exactly what they did before', async () => {
		const refused = await call('source', 'alice', 'GET', '?order=created&includeWithdrawn=true');
		deepStrictEqual([refused.status, refused.body.code], [403, 'include_withdrawn_forbidden']);
		const plain = await call('source', 'alice', 'GET', '?order=created&limit=50&includeSuperseded=true');
		strictEqual(plain.status, 200);
		strictEqual(plain.body.includeWithdrawn, undefined);
		ok(!plain.body.memories.some((memory: any) => memory.status === 'withdrawn'));
	});

	test('refuses a target that holds memories of its own, before writing', async () => {
		const own = await call('target', 'alice', 'PUT', memId('target-own'), shared('a memory written on the target'));
		strictEqual(own.status, 201, JSON.stringify(own.body));
		const before = (await listAll('target')).size;
		const refused = await runCopy(['--from', ctx.harper.httpURL, '--to', targetCtx.harper!.httpURL!]);
		strictEqual(refused.code, 1);
		deepStrictEqual(refused.report.preflight.foreign, [memId('target-own')]);
		strictEqual((await listAll('target')).size, before);
	});
});
