// Needs `npm run install:fixtures` first: the fixture app loads the packed plugin from its own node_modules.
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const require = createRequire(import.meta.url);
const fixturePath = join(import.meta.dirname, 'fixtures', 'memory-app-truncate');
const PASSWORD = 'Memory-test-1!';
const DOCUMENT_PREFIX = 'search_document: '.length;
const FALLBACK_CHARS = 4_000;

suite('@harperfast/agent-memory embeddingTruncate on a backend that cannot truncate', (ctx: ContextWithHarper) => {
	const basic = (username: string, password: string) =>
		'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	const authFor = (user: string) =>
		user === 'admin' ? basic(ctx.harper.admin.username, ctx.harper.admin.password) : basic(user, PASSWORD);
	const memId = (tag: string) => `mem-${tag}--`.padEnd(16, '_');
	const long = (head: string, tail: string) => `${head} ${'filler '.repeat(3_000)}${tail}`.slice(0, 20_000);

	async function operation(body: object) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: authFor('admin') },
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
				Authorization: authFor(user),
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

	const embedCalls = async () => {
		const response = await call('admin', 'GET', 'EmbedCall/');
		strictEqual(response.status, 200, JSON.stringify(response.body));
		return response.body as Array<{ inputType: string; longest: number; truncate: boolean }>;
	};

	before(async () => {
		await setupHarperWithFixture(ctx, fixturePath, {
			harperBinPath:
				process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ??
				join(dirname(require.resolve('harper')), 'bin', 'harper.js'),
			config: { logging: { stdStreams: true }, authentication: { authorizeLocal: false } },
		});
		await operation({ operation: 'add_role', role: 'member', permission: { super_user: false } });
		await operation({ operation: 'add_user', username: 'alice', password: PASSWORD, role: 'member', active: true });
		await operation({
			operation: 'upsert',
			database: 'memory',
			table: 'ScopeGrant',
			records: [{ id: 'role:member', read: ['global'], write: ['global'] }],
		});
		const deadline = Date.now() + 60_000;
		let ready = await call('admin', 'GET', 'Memory/?q=warmup');
		while (ready.status === 503 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			ready = await call('admin', 'GET', 'Memory/?q=warmup');
		}
		strictEqual(ready.status, 200, JSON.stringify(ready.body));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('writes, revises and imports long memories, embedding their first embeddingFallbackChars characters', async () => {
		const content = long('gannet colony survey', 'cormorant tailnote');
		const created = await call('alice', 'PUT', `Memory/${memId('gannet')}`, {
			title: 'gannet',
			content,
			visibility: 'shared',
		});
		strictEqual(created.status, 201, JSON.stringify(created.body));
		strictEqual((await call('alice', 'GET', `Memory/${memId('gannet')}`)).body.memory.content, content);
		const revised = await call(
			'alice',
			'PUT',
			`Memory/${memId('gannet')}`,
			{ title: 'gannet', content: long('gannet colony recount', 'shearwater tailnote') },
			{ 'If-Match': '"1"' },
		);
		strictEqual(revised.status, 200, JSON.stringify(revised.body));
		const imported = await call('admin', 'POST', 'Memory/import', {
			rows: [
				{
					id: createHash('sha256').update('flair:long-petrel').digest('hex').slice(0, 32),
					ownerId: 'alice',
					content: long('petrel burrow census', 'fulmar tailnote'),
					scopes: ['global'],
					status: 'active',
				},
			],
		});
		strictEqual(imported.status, 200, JSON.stringify(imported.body));
		deepStrictEqual(
			imported.body.results.map((result: any) => result.result),
			['created'],
		);

		const documents = (await embedCalls()).filter((row) => row.inputType === 'document');
		ok(documents.length >= 3, JSON.stringify(documents));
		for (const row of documents) {
			deepStrictEqual(row, { ...row, longest: DOCUMENT_PREFIX + FALLBACK_CHARS, truncate: false });
		}

		const logDir = ctx.harper.logDir!;
		const logs = readdirSync(logDir)
			.filter((name) => name.endsWith('.log'))
			.map((name) => readFileSync(join(logDir, name), 'utf8'))
			.join('\n');
		ok(
			/embeddingTruncate needs Harper 5\.4/.test(logs) ||
				/embeddingModel "prefixed" cannot truncate \(Backend 'test-window' does not support 'truncate'\)/.test(logs),
			'expected the fallback warning in the instance log',
		);
	});

	test('searches with the vector lane from a fallback query embedding', async () => {
		const before = (await embedCalls()).filter((row) => row.inputType === 'query').length;
		const searched = await call('alice', 'GET', 'Memory/?q=gannet%20recount');
		strictEqual(searched.status, 200, JSON.stringify(searched.body));
		ok(searched.body.memories.some((memory: any) => memory.id === memId('gannet')));
		const queries = (await embedCalls()).filter((row) => row.inputType === 'query');
		strictEqual(queries.length, before + 1, JSON.stringify(queries));
		ok(queries.every((row) => row.truncate === false));
	});

	test('still fails a write whose embedding backend is down after the refusal', async () => {
		const failed = await call('alice', 'PUT', `Memory/${memId('bittern')}`, {
			title: 'bittern',
			content: 'EMBED-DOWN bittern write',
		});
		strictEqual(failed.status, 503, JSON.stringify(failed.body));
		strictEqual(failed.body.code, 'unavailable');
		strictEqual((await call('alice', 'GET', `Memory/${memId('bittern')}`)).status, 404);
	});
});
