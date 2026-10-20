import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelBackend, ModelBackendError } from '../scripts/lib/model-backend.mjs';

const SCHEMA = {
	type: 'object',
	properties: { verdict: { type: 'string' } },
	required: ['verdict'],
	additionalProperties: false,
};
const PROMPT = 'SECRET-PROMPT-TEXT about the north lake';
let dir;

// A fake `claude` executable; `body` runs after it has read stdin into `input` and saved its argv.
async function fakeCli(name, body, { readStdin = true } = {}) {
	const path = join(dir, name);
	await writeFile(
		path,
		`#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(`${path}.argv`)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env) }));
${
	readStdin
		? `let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	writeFileSync(${JSON.stringify(`${path}.stdin`)}, input);
	${body}
});`
		: body
}
`,
	);
	await chmod(path, 0o755);
	return path;
}

async function failure(promise) {
	const error = await promise.then(
		() => null,
		(reason) => reason,
	);
	assert.ok(error instanceof ModelBackendError, `expected a ModelBackendError, got ${error}`);
	assert.ok(!error.message.includes('SECRET'), 'a failure never echoes the prompt or the reply');
	return error.code;
}

const complete = (command, options = {}) =>
	createModelBackend('claude', { command, ...options }).complete({ system: 'Judge.', prompt: PROMPT, schema: SCHEMA });

before(async () => {
	dir = await mkdtemp(join(tmpdir(), 'model-backend-'));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('createModelBackend', () => {
	it('rejects an unknown backend and a stub without a respond function', () => {
		assert.throws(() => createModelBackend('openai'), /unknown model backend/);
		assert.throws(() => createModelBackend('stub'), /respond function/);
	});

	it('stub answers through the caller-supplied function', async () => {
		const backend = createModelBackend('stub', { respond: ({ prompt }) => ({ verdict: prompt.length }) });
		assert.equal(backend.name, 'stub');
		assert.deepEqual(await backend.complete({ system: 's', prompt: 'abc', schema: SCHEMA }), { verdict: 3 });
	});
});

describe('claude backend', () => {
	it('sends the prompt on stdin, runs in the temp directory without customizations, and returns structured_output', async () => {
		const cli = await fakeCli(
			'ok',
			`process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'x', structured_output: { verdict: 'supersedes' } }));`,
		);
		const env = { ...process.env, AGENT_MEMORY_PASS: 'target-secret', FLAIR_ADMIN_PASS: 'source-secret', KEEP_ME: '1' };
		assert.deepEqual(await complete(cli, { model: 'haiku', env }), { verdict: 'supersedes' });
		assert.equal(await readFile(`${cli}.stdin`, 'utf8'), PROMPT);
		const { argv, cwd, env: childEnv } = JSON.parse(await readFile(`${cli}.argv`, 'utf8'));
		assert.equal(cwd, tmpdir());
		assert.ok(childEnv.includes('KEEP_ME'));
		assert.ok(!childEnv.some((name) => name.startsWith('AGENT_MEMORY_') || name.startsWith('FLAIR_')));
		assert.ok(!argv.some((arg) => arg.includes('SECRET')), 'the prompt never appears in argv');
		for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
			assert.ok(argv.includes(flag), flag);
		}
		assert.equal(argv[argv.indexOf('--tools') + 1], '');
		assert.equal(argv[argv.indexOf('--json-schema') + 1], JSON.stringify(SCHEMA));
		assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
	});

	it('fails with a code, never the reply, for an error result, missing structured output, bad JSON or a non-zero exit', async () => {
		const cases = [
			[
				'is-error',
				`process.stdout.write(JSON.stringify({ is_error: true, result: 'SECRET echo' }));`,
				'cli_error_result',
			],
			[
				'no-structured',
				`process.stdout.write(JSON.stringify({ is_error: false, result: 'SECRET echo' }));`,
				'cli_no_structured_output',
			],
			['not-json', `process.stdout.write('SECRET not json');`, 'cli_invalid_output'],
			['exit-3', `process.stderr.write('SECRET stderr'); process.exit(3);`, 'cli_exit_3'],
		];
		for (const [name, body, code] of cases) {
			assert.equal(await failure(complete(await fakeCli(name, body))), code, name);
		}
	});

	it('fails cli_not_found when the executable is missing', async () => {
		assert.equal(await failure(complete(join(dir, 'missing'))), 'cli_not_found');
	});

	it('survives a CLI that exits before reading the prompt', async () => {
		const cli = await fakeCli('early-exit', `process.exit(0);`, { readStdin: false });
		const code = await failure(
			createModelBackend('claude', { command: cli }).complete({
				system: 'Judge.',
				prompt: 'SECRET '.repeat(200_000),
				schema: SCHEMA,
			}),
		);
		assert.ok(['cli_stdin_closed', 'cli_invalid_output'].includes(code), code);
	});

	// These fakes act before reading stdin, and the deadlines leave seconds for a slow start on a loaded machine: a
	// CLI killed before it ran its first line would test nothing.
	it('kills a CLI that runs past the timeout and settles only after it has exited', async () => {
		const pidFile = join(dir, 'hang.pid');
		const cli = await fakeCli(
			'hang',
			`process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
			{ readStdin: false },
		);
		assert.equal(await failure(complete(cli, { timeoutMs: 1_500 })), 'cli_timeout');
		const pid = Number(await readFile(pidFile, 'utf8'));
		assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the child was reaped before the call settled');
	});

	it('settles at the timeout when the CLI exited but a descendant still holds its output open', async () => {
		const pidFile = join(dir, 'orphan.pid');
		const cli = await fakeCli(
			'orphan',
			`const { spawn } = require('node:child_process');
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));
process.exit(0);`,
			{ readStdin: false },
		);
		const started = Date.now();
		try {
			assert.equal(await failure(complete(cli, { timeoutMs: 1_500 })), 'cli_timeout');
			assert.ok(Date.now() - started < 30_000, 'settled long before the descendant let go of the output');
		} finally {
			const holder = await readFile(pidFile, 'utf8').catch(() => undefined);
			if (holder) process.kill(Number(holder), 'SIGKILL');
		}
	});

	it('settles at the timeout when the CLI exited but a descendant still holds its output open', async () => {
		const cli = await fakeCli(
			'orphan',
			`const { spawn } = require('node:child_process');
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
writeFileSync(${JSON.stringify(join(dir, 'orphan.pid'))}, String(holder.pid));
process.exit(0);`,
		);
		const started = Date.now();
		try {
			assert.equal(await failure(complete(cli, { timeoutMs: 300 })), 'cli_timeout');
			assert.ok(Date.now() - started < 4_000);
		} finally {
			process.kill(Number(await readFile(join(dir, 'orphan.pid'), 'utf8')), 'SIGKILL');
		}
	});

	it('kills a CLI whose output exceeds the cap', async () => {
		const cli = await fakeCli(
			'flood',
			`const chunk = 'x'.repeat(65536); setInterval(() => process.stdout.write(chunk), 1);`,
		);
		assert.equal(await failure(complete(cli)), 'cli_output_too_large');
	});
});

describe('anthropic backend', () => {
	let server;
	const requests = [];
	let reply;

	before(async () => {
		server = createServer(async (request, response) => {
			let body = '';
			for await (const chunk of request) body += chunk;
			requests.push({ headers: request.headers, body: JSON.parse(body) });
			const { status = 200, json } = reply();
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(json));
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
	});

	after(() => server.close());

	const message = (stopReason, text) => ({
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-opus-5-5',
		content: [{ type: 'text', text }],
		stop_reason: stopReason,
		usage: { input_tokens: 1, output_tokens: 1 },
	});
	const backend = (options = {}) =>
		createModelBackend('anthropic', {
			env: { ANTHROPIC_API_KEY: 'test-key' },
			timeoutMs: 5_000,
			...options,
		});
	const call = (options) => backend(options).complete({ system: 'Judge.', prompt: PROMPT, schema: SCHEMA });

	before(() => {
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
	});
	after(() => {
		delete process.env.ANTHROPIC_BASE_URL;
	});

	it('asks for schema-constrained output with server-side fallbacks and parses the reply', async () => {
		requests.length = 0;
		reply = () => ({ json: message('end_turn', '{"verdict":"refines"}') });
		assert.deepEqual(await call({ effort: 'medium', maxTokens: 2000 }), { verdict: 'refines' });
		const [{ headers, body }] = requests;
		assert.equal(headers['x-api-key'], 'test-key');
		assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
		assert.equal(body.model, 'claude-opus-5-5');
		assert.equal(body.max_tokens, 2000);
		assert.equal(body.fallbacks, 'default');
		assert.deepEqual(body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } });
		assert.deepEqual(body.messages, [{ role: 'user', content: PROMPT }]);
	});

	it('takes the key from the env it was given, never the process environment', async () => {
		process.env.ANTHROPIC_API_KEY ??= 'process-key';
		requests.length = 0;
		assert.equal(await failure(call({ env: {} })), 'anthropic_no_api_key');
		assert.equal(requests.length, 0);
	});

	it('fails on a refusal, a truncated reply, unparseable text and an HTTP error, by code only', async () => {
		reply = () => ({ json: message('refusal', 'SECRET partial') });
		assert.equal(await failure(call()), 'anthropic_stop_refusal');
		reply = () => ({ json: message('max_tokens', '{"verdict":') });
		assert.equal(await failure(call()), 'anthropic_stop_max_tokens');
		reply = () => ({ json: message('end_turn', 'SECRET not json') });
		assert.equal(await failure(call()), 'anthropic_invalid_output');
		reply = () => ({
			status: 400,
			json: { type: 'error', error: { type: 'invalid_request_error', message: 'SECRET' } },
		});
		assert.equal(await failure(call()), 'anthropic_http_400');
	});
});
