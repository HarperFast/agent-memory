// Needs `npm run install:fixtures` first: each fixture app loads its own packed copy of the plugin from its own
// node_modules, so memory-consumer's import is a different module instance from the plugin memory-service runs.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const PASSWORD = 'Memory-test-1!';

async function startWithApps(ctx: ContextWithHarper, apps: string[], applications?: Record<string, unknown>) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-'),
	);
	for (const app of apps) {
		await cp(join(import.meta.dirname, 'fixtures', app), join(dataRootDir, 'components', app), {
			recursive: true,
			dereference: true,
		});
	}
	(ctx as any).harper = { dataRootDir };
	await startHarper(ctx, {
		harperBinPath:
			process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
			join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
		// One worker, so every request meets the same plugin instance; Harper otherwise treats a credential-less
		// loopback request as super_user.
		config: {
			threads: { count: 1 },
			logging: { stdStreams: true },
			authentication: { authorizeLocal: false },
			...(applications ? { applications } : {}),
		},
	});
}

function client(ctx: ContextWithHarper) {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const admin = () => basic(ctx.harper.admin.username, ctx.harper.admin.password);

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: admin() },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		ok(response.ok, `${JSON.stringify(body)} → ${response.status} ${text}`);
		return JSON.parse(text);
	}

	async function call(user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: user === 'admin' ? admin() : basic(user, PASSWORD),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, body: parsed };
	}

	async function seedUsers() {
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		for (const username of ['alice', 'erin']) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role: 'member', active: true });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [{ id: 'role:member', read: ['global'], write: ['global'] }],
		});
	}

	const sinkRows = async (memoryId: string) =>
		(
			await operation({
				operation: 'search_by_value',
				database: 'memory',
				table: 'SinkLog',
				search_attribute: 'memoryId',
				search_value: memoryId,
				get_attributes: ['*'],
			})
		)
			.map((row: any) => [row.kind, row.revision, row.status])
			.sort((a: any[], b: any[]) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])));

	// A new table's full-text index builds after boot; until then search answers 503 unavailable.
	async function searchReady(path: string) {
		const deadline = Date.now() + 60_000;
		let response = await call('admin', 'GET', `${path}/?q=warmup`);
		while (response.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			response = await call('admin', 'GET', `${path}/?q=warmup`);
		}
		return response.status;
	}

	return { operation, call, seedUsers, sinkRows, searchReady };
}

const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');

for (const moduleLoader of ['vm-current-context', 'vm']) {
	suite(
		`a second app importing @harperfast/agent-memory reaches the plugin (${moduleLoader} loader)`,
		(ctx: ContextWithHarper) => {
			const { call, seedUsers, sinkRows, searchReady } = client(ctx);

			before(async () => {
				await startWithApps(ctx, ['memory-service', 'memory-consumer'], { moduleLoader });
				await seedUsers();
				strictEqual(await searchReady('Memory'), 200);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			test('the consumer imports its own copy, and only process state crosses the apps under this loader', async () => {
				const probe = await call('alice', 'GET', 'PrincipalProbe/?labels=global');
				strictEqual(probe.status, 200, JSON.stringify(probe.body));
				ok(String(probe.body.packagePath).includes('/memory-consumer/node_modules/'), probe.body.packagePath);
				strictEqual(probe.body.seesServiceGlobal, moduleLoader === 'vm-current-context');
			});

			test("the consumer's sink sees create, revise and withdraw inside the plugin's transaction", async () => {
				const id = memId(`sink-${moduleLoader}`);
				strictEqual((await call('alice', 'PUT', `Memory/${id}`, { title: 'x', content: 'heron wading' })).status, 201);
				const revised = await call('alice', 'PUT', `Memory/${id}`, { content: 'heron fishing' }, { 'If-Match': '"1"' });
				strictEqual(revised.status, 200, JSON.stringify(revised.body));
				const withdrawn = await call('alice', 'DELETE', `Memory/${id}?reason=done`, undefined, { 'If-Match': '"2"' });
				strictEqual(withdrawn.status, 200, JSON.stringify(withdrawn.body));
				deepStrictEqual(await sinkRows(id), [
					['write', 1, 'active'],
					['write', 2, 'active'],
					['withdraw', 3, 'withdrawn'],
				]);
			});

			test('a failing consumer sink rolls back the memory and its own row, and the next write succeeds', async () => {
				const failedId = memId(`fail-${moduleLoader}`);
				const failed = await call('alice', 'PUT', `Memory/${failedId}`, { title: 'x', content: 'SINK-FAIL' });
				strictEqual(failed.status, 500, JSON.stringify(failed.body));
				deepStrictEqual(await sinkRows(failedId), []);
				strictEqual((await call('alice', 'GET', `Memory/${failedId}`)).status, 404);
				const next = memId(`next-${moduleLoader}`);
				strictEqual((await call('alice', 'PUT', `Memory/${next}`, { title: 'x', content: 'egret' })).status, 201);
				deepStrictEqual(await sinkRows(next), [['write', 1, 'active']]);
			});

			test("the consumer's principal resolver applies on the plugin's routes", async () => {
				const id = memId(`erin-${moduleLoader}`);
				const created = await call('erin', 'PUT', `Memory/${id}`, {
					title: 'x',
					content: 'agent note',
					visibility: 'shared',
				});
				strictEqual(created.status, 201, JSON.stringify(created.body));
				const fetched = await call('erin', 'GET', `Memory/${id}`);
				strictEqual(fetched.body.memory.ownerId, 'agent-erin');
				strictEqual(fetched.body.memory.author.source, 'consumer-resolver');
			});

			test("the consumer's resolvePrincipal and canReadLabels answer with the plugin's grants", async () => {
				const erin = await call('erin', 'GET', 'PrincipalProbe/?labels=global');
				strictEqual(erin.status, 200, JSON.stringify(erin.body));
				deepStrictEqual(
					[erin.body.principal.id, erin.body.principal.source, erin.body.canRead],
					['agent-erin', 'consumer-resolver', true],
				);
				const alice = await call('alice', 'GET', 'PrincipalProbe/?labels=team:z');
				deepStrictEqual(
					[alice.body.principal.id, alice.body.principal.read, alice.body.canRead],
					['alice', ['user:alice', 'global'], false],
				);
			});

			test("the consumer's bootstrap section reaches the plugin's bootstrap, rendered for the caller", async () => {
				const id = memId(`boot-${moduleLoader}`);
				strictEqual((await call('alice', 'PUT', `Memory/${id}`, { title: 'x', content: 'plover' })).status, 201);
				const booted = await call('alice', 'GET', 'Memory/bootstrap?budget=8000');
				strictEqual(booted.status, 200, JSON.stringify(booted.body));
				const sections = booted.body.memories.map((entry: any) => entry.section);
				const at = sections.indexOf('consumerOrientation');
				ok(at !== -1 && at < sections.indexOf('recent'), JSON.stringify(sections));
				deepStrictEqual(booted.body.memories[at], {
					title: 'Orientation',
					content: 'for alice within 8000',
					section: 'consumerOrientation',
				});
			});

			test("the consumer's annotator adds per-hit data to the plugin's search", async () => {
				const id = memId(`note-${moduleLoader}`);
				const created = await call('alice', 'PUT', `Memory/${id}`, {
					title: 'x',
					content: 'sandpiper probing',
					visibility: 'shared',
				});
				strictEqual(created.status, 201, JSON.stringify(created.body));
				const searched = await call('alice', 'GET', 'Memory/?q=sandpiper');
				strictEqual(searched.status, 200, JSON.stringify(searched.body));
				const hit = searched.body.memories.find((memory: any) => memory.id === id);
				deepStrictEqual(hit?.consumerNote, { by: 'alice', readable: true });
				const listed = await call('alice', 'GET', 'Memory/?limit=50');
				ok(
					listed.body.memories.every((memory: any) => !('consumerNote' in memory)),
					'a listing is not annotated',
				);
			});

			test("the consumer's scanMemories reads every memory through the plugin, resumes after a row and fetches by id", async () => {
				const probe = await call('alice', 'GET', 'ScanProbe/');
				strictEqual(probe.status, 200, JSON.stringify(probe.body));
				ok(probe.body.ids.length >= 2, JSON.stringify(probe.body));
				deepStrictEqual(probe.body.resumed, probe.body.ids.slice(1));
				strictEqual(probe.body.embedded, true);
				deepStrictEqual(probe.body.fetched, [probe.body.ids.at(-1), probe.body.ids[0]]);
				strictEqual(probe.body.fetchedEmbedded, true);
			});
		},
	);
}

suite('a second app listing the plugin beside the one already running', (ctx: ContextWithHarper) => {
	const { call, seedUsers, sinkRows, searchReady } = client(ctx);
	let ready: number[];

	before(async () => {
		await startWithApps(ctx, ['memory-service', 'memory-service-dup', 'memory-consumer']);
		await seedUsers();
		ready = await Promise.all([searchReady('Memory'), searchReady('MemoryDup')]);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('fails to load, and the first plugin keeps serving the consumer', async () => {
		// Startup order picks which app's plugin loads first; exactly one of the two mounts serves.
		const viaPrimary = memId('dup-primary');
		const viaDuplicate = memId('dup-second');
		const [primary, duplicate] = await Promise.all([
			call('alice', 'PUT', `Memory/${viaPrimary}`, { title: 'x', content: 'kingfisher' }),
			call('alice', 'PUT', `MemoryDup/${viaDuplicate}`, { title: 'x', content: 'kingfisher' }),
		]);
		notStrictEqual(primary.status === 201, duplicate.status === 201, JSON.stringify([primary, duplicate]));
		deepStrictEqual(
			ready.map((status) => status === 200),
			[primary.status === 201, duplicate.status === 201],
		);
		const id = primary.status === 201 ? viaPrimary : viaDuplicate;
		deepStrictEqual(await sinkRows(id), [['write', 1, 'active']]);
		const probe = await call('alice', 'GET', 'PrincipalProbe/?labels=global');
		strictEqual(probe.body.canRead, true, JSON.stringify(probe.body));
	});
});
