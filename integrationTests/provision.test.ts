// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
// The fixture's provision.js and schema.graphql are symlinks to deploy/engineering, so this runs the shipped files.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'provision-app');
const rolesPath = join(import.meta.dirname, '..', 'deploy', 'engineering', 'roles.json');
const PASSWORD = 'Provision-test-1!';
const PROVISIONER = 'dispatch-provisioner';

suite('deploy/engineering self-serve provisioning over HTTP', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	// Every password the resource issues, checked against Harper's log at the end.
	const issued: string[] = [];
	const passwords = new Map<string, string>();

	async function operationAs(auth: string | undefined, body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	}

	async function operation(body: object) {
		const result = await operationAs(basic(ctx.harper.admin.username, ctx.harper.admin.password), body);
		ok(result.status < 300, `${JSON.stringify(body)} → ${result.status} ${JSON.stringify(result.body)}`);
		return result.body;
	}

	async function http(auth: string | undefined, method: string, path: string, body?: unknown, headers = {}) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				...(auth && { Authorization: auth }),
				...headers,
			},
			body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, headers: response.headers, body: parsed };
	}

	const asUser = (username: string) => basic(username, passwords.get(username) ?? PASSWORD);
	const provision = (body: object, as = PROVISIONER) => http(asUser(as), 'POST', '/Provision/', body);
	const describeUser = (email: string, as = PROVISIONER) =>
		http(asUser(as), 'GET', `/Provision/${encodeURIComponent(email)}`);

	async function issue(body: object) {
		const response = await provision(body);
		ok(
			response.status === 201 || response.status === 200,
			`${JSON.stringify(body)} → ${response.status} ${JSON.stringify(response.body)}`,
		);
		strictEqual(response.headers.get('cache-control'), 'no-store');
		issued.push(response.body.password);
		passwords.set(response.body.username, response.body.password);
		return response.body;
	}

	const memory = (user: string, method: string, path: string, body?: unknown, revision?: number) =>
		http(asUser(user), method, `/Memory/${path}`, body, revision === undefined ? {} : { 'If-Match': `"${revision}"` });
	const memId = (tag: string) => `mem-prov-${tag}`.padEnd(16, '_');

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: {
				threads: { count: 1 },
				// The most Harper logs, so the password check below covers every log line it can write.
				logging: { level: 'trace' },
				authentication: { authorizeLocal: false },
			},
		});
		for (const op of JSON.parse(readFileSync(rolesPath, 'utf8'))) await operation(op);
		for (const role of ['eng', 'eng-agents', 'dispatch-worker']) {
			await operation({ operation: 'add_role', role, permission: { super_user: false } });
		}
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [
				{ id: 'role:eng', read: ['global', 'customer:*'], write: ['global', 'customer:*'] },
				{ id: 'role:eng-agents', read: ['global', 'customer:*'], write: ['global', 'customer:*'] },
				{ id: 'role:dispatch-worker', read: ['global'], write: ['global'] },
			],
		});
		for (const [username, role] of [
			[PROVISIONER, 'provisioner'],
			['admin-made@example.com', 'eng'],
			['agents-user', 'eng-agents'],
			['fleet-worker', 'dispatch-worker'],
			['root@example.com', 'super_user'],
		]) {
			await operation({ operation: 'add_user', username, password: PASSWORD, role, active: true });
		}
		const deadline = Date.now() + 60_000;
		let ready = await memory('admin-made@example.com', 'GET', '?q=warmup');
		while (ready.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			ready = await memory('admin-made@example.com', 'GET', '?q=warmup');
		}
		strictEqual(ready.status, 200, JSON.stringify(ready.body));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('only the provisioner (or a super_user) reaches the resource, and the provisioner gets no operations', async () => {
		strictEqual((await http(undefined, 'GET', '/Provision/admin-made%40example.com')).status, 401);
		strictEqual(
			(await http(undefined, 'POST', '/Provision/', { action: 'create', principal: 'x@example.com', role: 'eng' }))
				.status,
			401,
		);
		for (const user of ['admin-made@example.com', 'agents-user', 'fleet-worker']) {
			const read = await describeUser('admin-made@example.com', user);
			strictEqual(read.status, 403, user);
			strictEqual(read.body.code, 'provisioner_required');
			const create = await provision(
				{ action: 'create', principal: `by-${user.replace('@', '-at-')}@example.com`, role: 'eng' },
				user,
			);
			strictEqual(create.status, 403, user);
		}
		strictEqual((await describeUser('admin-made@example.com', 'root@example.com')).status, 200);
		strictEqual((await describeUser('nobody@example.com')).body.exists, false);

		const auth = asUser(PROVISIONER);
		for (const body of [
			{ operation: 'add_user', username: 'direct@example.com', password: PASSWORD, role: 'super_user', active: true },
			{ operation: 'alter_user', username: 'admin-made@example.com', password: PASSWORD },
			{ operation: 'list_users' },
		]) {
			const refused = await operationAs(auth, body);
			strictEqual(refused.status, 403, JSON.stringify(refused.body));
		}
	});

	test('the resource stays out of OpenAPI and answers other verbs and streams with 405', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			strictEqual(
				(await http(asUser(PROVISIONER), method, '/Provision/admin-made%40example.com', {})).status,
				405,
				method,
			);
		}
		const stream = await http(asUser(PROVISIONER), 'GET', '/Provision/admin-made%40example.com', undefined, {
			Accept: 'text/event-stream',
		});
		ok(
			stream.status !== 200 || !String(stream.headers.get('content-type')).includes('event-stream'),
			`${stream.status}`,
		);
		const admin = basic(ctx.harper.admin.username, ctx.harper.admin.password);
		const openapi = await http(admin, 'GET', '/openapi');
		strictEqual(openapi.status, 200);
		deepStrictEqual(
			Object.keys(openapi.body.paths ?? {}).filter((path) => path.includes('Provision')),
			[],
		);
		strictEqual((await http(admin, 'GET', '/ProvisionedUser/')).status, 404);
	});

	test('create issues an eng-public credential that reads and writes global only, once per person', async () => {
		const pub = await issue({ action: 'create', principal: 'pub@example.com', role: 'eng-public' });
		strictEqual(pub.username, 'pub@example.com');
		const again = await provision({ action: 'create', principal: 'pub@example.com', role: 'eng' });
		strictEqual(again.status, 409);
		strictEqual(again.body.code, 'user_exists');
		const adminMade = await provision({ action: 'create', principal: 'admin-made@example.com', role: 'eng-public' });
		strictEqual(adminMade.status, 409);

		strictEqual(
			(
				await memory('pub@example.com', 'PUT', memId('pub-global'), {
					title: 'g',
					content: 'global note',
					visibility: 'shared',
				})
			).status,
			201,
		);
		strictEqual(
			(await memory('pub@example.com', 'PUT', memId('pub-private'), { title: 'p', content: 'private note' })).status,
			201,
		);
		const customerWrite = await memory('pub@example.com', 'PUT', memId('pub-customer'), {
			title: 'c',
			content: 'customer note',
			scopes: ['customer:acme'],
		});
		strictEqual(customerWrite.status, 403, JSON.stringify(customerWrite.body));

		const secret = memId('acme-secret');
		strictEqual(
			(
				await memory('admin-made@example.com', 'PUT', secret, {
					title: 'acme',
					content: 'acme detail',
					scopes: ['customer:acme'],
				})
			).status,
			201,
		);
		strictEqual((await memory('pub@example.com', 'GET', secret)).status, 404);
		strictEqual((await memory('pub@example.com', 'PUT', secret, { content: 'overwrite' }, 1)).status, 409);
		const sees = (await memory('pub@example.com', 'GET', '?q=acme+detail&limit=50')).body.memories.map(
			(m: any) => m.id,
		);
		ok(!sees.includes(secret), JSON.stringify(sees));
		const global = (await memory('admin-made@example.com', 'GET', memId('pub-global'))).body.memory;
		deepStrictEqual(global.scopes, ['global']);
	});

	test('it assigns only eng and eng-public', async () => {
		for (const role of ['super_user', 'provisioner', 'dispatch-worker', 'eng-agents']) {
			const principal = `as-${role}@example.com`;
			const response = await provision({ action: 'create', principal, role });
			strictEqual(response.status, 403, role);
			strictEqual(response.body.code, 'role_not_assignable');
			strictEqual((await describeUser(principal)).body.exists, false, role);
		}
	});

	test('addDelegate creates a same-role delegate acting for the person, which edits the person’s memories', async () => {
		const id = memId('pub-edit');
		strictEqual(
			(await memory('pub@example.com', 'PUT', id, { title: 't', content: 'stale', visibility: 'shared' })).status,
			201,
		);
		const delegate = await issue({
			action: 'addDelegate',
			principal: 'pub@example.com',
			machine: 'laptop',
			role: 'eng-public',
		});
		strictEqual(delegate.username, 'pub@example.com.laptop');
		const [row] = await operation({
			operation: 'search_by_id',
			database: 'memory',
			table: 'ScopeGrant',
			ids: ['user:pub@example.com.laptop'],
			get_attributes: ['id', 'actsFor', 'read', 'write'],
		});
		strictEqual(row.actsFor, 'pub@example.com');
		ok(!row.read?.length && !row.write?.length, JSON.stringify(row));

		const revised = await memory('pub@example.com.laptop', 'PUT', id, { content: 'corrected' }, 1);
		strictEqual(revised.status, 200, JSON.stringify(revised.body));
		const stored = (await memory('pub@example.com', 'GET', id)).body.memory;
		strictEqual(stored.ownerId, 'pub@example.com');
		strictEqual(stored.lastEditor.principalId, 'pub@example.com.laptop');
		strictEqual((await memory('pub@example.com.laptop', 'GET', memId('acme-secret'))).status, 404);

		const duplicate = await provision({
			action: 'addDelegate',
			principal: 'pub@example.com',
			machine: 'laptop',
			role: 'eng-public',
		});
		strictEqual(duplicate.status, 409);
		strictEqual(duplicate.body.code, 'user_exists');
		const unmanaged = await provision({
			action: 'addDelegate',
			principal: 'admin-made@example.com',
			machine: 'desk',
			role: 'eng',
		});
		strictEqual(unmanaged.status, 403);
		strictEqual(unmanaged.body.code, 'not_managed');

		deepStrictEqual((await describeUser('pub@example.com')).body, {
			exists: true,
			managed: true,
			role: 'eng-public',
			delegates: [{ username: 'pub@example.com.laptop', role: 'eng-public', actsFor: true }],
		});
	});

	test("an eng person's eng-public machine is a standalone user outside the person's private scope", async () => {
		await issue({ action: 'create', principal: 'cleared@example.com', role: 'eng' });
		const desk = await issue({ action: 'addDelegate', principal: 'cleared@example.com', machine: 'desk', role: 'eng' });
		strictEqual(desk.actsFor, true);
		strictEqual((await memory('cleared@example.com.desk', 'GET', memId('acme-secret'))).status, 200);

		const personal = await issue({
			action: 'addDelegate',
			principal: 'cleared@example.com',
			machine: 'personal',
			role: 'eng-public',
		});
		strictEqual(personal.actsFor, false);
		const rows = await operation({
			operation: 'search_by_id',
			database: 'memory',
			table: 'ScopeGrant',
			ids: ['user:cleared@example.com.personal'],
			get_attributes: ['id', 'actsFor'],
		});
		deepStrictEqual(rows, []);
		const privateNote = memId('cleared-private');
		const sharedNote = memId('cleared-shared');
		strictEqual(
			(await memory('cleared@example.com', 'PUT', privateNote, { title: 'p', content: 'acme private' })).status,
			201,
		);
		strictEqual(
			(await memory('cleared@example.com', 'PUT', sharedNote, { title: 's', content: 'shared', visibility: 'shared' }))
				.status,
			201,
		);
		const machine = 'cleared@example.com.personal';
		strictEqual((await memory(machine, 'GET', privateNote)).status, 404);
		strictEqual((await memory(machine, 'GET', memId('acme-secret'))).status, 404);
		const edit = await memory(machine, 'PUT', sharedNote, { content: 'edited' }, 1);
		strictEqual(edit.status, 403, JSON.stringify(edit.body));
		strictEqual(edit.body.code, 'not_memory_owner');
		const own = await memory(machine, 'PUT', memId('personal-note'), { title: 'n', content: 'mine' });
		strictEqual(own.status, 201);
		strictEqual((await memory('cleared@example.com', 'GET', memId('personal-note'))).status, 404);

		deepStrictEqual((await describeUser('cleared@example.com')).body.delegates, [
			{ username: 'cleared@example.com.desk', role: 'eng', actsFor: true },
			{ username: 'cleared@example.com.personal', role: 'eng-public', actsFor: false },
		]);
		strictEqual((await issue({ action: 'rotate', username: machine })).username, machine);
	});

	test('rotate replaces the password of a managed user only, and the old password stops working', async () => {
		const username = 'pub@example.com.laptop';
		const old = passwords.get(username)!;
		const rotated = await issue({ action: 'rotate', username });
		strictEqual(rotated.username, username);
		ok(rotated.password !== old);
		strictEqual((await http(basic(username, old), 'GET', '/Memory/?q=note')).status, 401);
		strictEqual((await memory(username, 'GET', '?q=note')).status, 200);

		for (const [target, status, code] of [
			['admin-made@example.com', 403, 'not_managed'],
			['root@example.com', 403, 'not_managed'],
			[PROVISIONER, 403, 'not_managed'],
			['nobody@example.com', 404, 'user_not_found'],
		] as const) {
			const response = await provision({ action: 'rotate', username: target });
			strictEqual(response.status, status, target);
			strictEqual(response.body.code, code);
		}
		strictEqual((await memory('admin-made@example.com', 'GET', '?q=note')).status, 200);

		await operation({ operation: 'alter_user', username: 'cleared@example.com.desk', role: 'super_user' });
		const promoted = await provision({ action: 'rotate', username: 'cleared@example.com.desk' });
		strictEqual(promoted.status, 403);
		strictEqual(promoted.body.code, 'role_not_assignable');
	});

	test('Harper writes none of the issued passwords to its log', async () => {
		ok(issued.length >= 5, `${issued.length} passwords issued`);
		// read_log finds the log wherever the harness put it; the operation log's add_user lines show it covers the run.
		let logs = '';
		const deadline = Date.now() + 10_000;
		while (!logs.includes('add_user') && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			logs = JSON.stringify(await operation({ operation: 'read_log', limit: 100_000 }));
		}
		ok(logs.includes('add_user'), 'the log does not cover the provisioning requests');
		for (const password of issued) ok(!logs.includes(password), 'an issued password is in the Harper log');
	});
});
