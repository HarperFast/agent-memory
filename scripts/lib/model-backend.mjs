// One interface over the model backends the operator scripts judge with. A failure rejects with a ModelBackendError
// whose message is a fixed code: a prompt carries memory content, and a backend's stderr or reply can echo it.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const MODEL_BACKENDS = ['claude', 'anthropic', 'stub'];
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const DEFAULT_TIMEOUT_MS = 120_000;
const CLI_OUTPUT_MAX_BYTES = 1_000_000;
const CLI_KILL_GRACE_MS = 5_000;
// Thinking is always on for the default model and counts against max_tokens.
const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;
const ANTHROPIC_MAX_RETRIES = 2;

export class ModelBackendError extends Error {
	constructor(code) {
		super(`model backend failed: ${code}`);
		this.code = code;
	}
}

/**
 * `complete({ system, prompt, schema })` resolves to an object the backend constrained to `schema`. `respond` is the
 * stub's deterministic answer function; `command` replaces the `claude` executable (tests). `effort` and `maxTokens`
 * apply to `anthropic`; the CLI runs at its own defaults.
 */
export function createModelBackend(
	name,
	{
		model,
		env = process.env,
		respond,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		command = 'claude',
		effort = 'low',
		maxTokens = DEFAULT_ANTHROPIC_MAX_TOKENS,
	} = {},
) {
	switch (name) {
		case 'claude':
			return { name, complete: (request) => completeWithCli(request, { model, env, timeoutMs, command }) };
		case 'anthropic':
			return {
				name,
				complete: anthropicCompleter({ model: model ?? DEFAULT_ANTHROPIC_MODEL, env, timeoutMs, effort, maxTokens }),
			};
		case 'stub':
			if (typeof respond !== 'function') throw new Error('the stub backend needs a respond function');
			return { name, complete: async (request) => respond(request) };
		default:
			throw new Error(`unknown model backend ${JSON.stringify(name)}; use one of ${MODEL_BACKENDS.join(', ')}`);
	}
}

// `--safe-mode` keeps CLAUDE.md, hooks, plugins and MCP servers out (a memory plugin's prompt hook would send the
// prompt to its server) while OAuth still works; `--bare` would drop OAuth. Managed (policy) hooks still run.
function completeWithCli({ system, prompt, schema }, { model, env, timeoutMs, command }) {
	const args = [
		'-p',
		'--safe-mode',
		'--tools',
		'',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--output-format',
		'json',
		'--json-schema',
		JSON.stringify(schema),
		'--system-prompt',
		system,
		...(model ? ['--model', model] : []),
	];
	return new Promise((resolve, reject) => {
		const chunks = [];
		let bytes = 0;
		let failure;
		let killTimer;
		// The prompt goes over stdin, never argv, where other local users could read it.
		const child = spawn(command, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
		const fail = (code) => {
			failure ??= code;
			if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), CLI_KILL_GRACE_MS);
		};
		const timer = setTimeout(() => fail('cli_timeout'), timeoutMs);
		child.on('error', (error) => {
			if (child.pid !== undefined) return fail('cli_failed');
			clearTimeout(timer);
			reject(new ModelBackendError(error.code === 'ENOENT' ? 'cli_not_found' : 'cli_spawn_failed'));
		});
		child.stdin.on('error', () => fail('cli_stdin_closed'));
		child.stdout.on('data', (chunk) => {
			bytes += chunk.length;
			if (bytes > CLI_OUTPUT_MAX_BYTES) return fail('cli_output_too_large');
			chunks.push(chunk);
		});
		// 'close' follows the exit and the end of stdout, so no child outlives a settled call.
		child.on('close', (exitCode) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			if (failure) return reject(new ModelBackendError(failure));
			if (exitCode !== 0) return reject(new ModelBackendError(`cli_exit_${exitCode}`));
			let result;
			try {
				result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				return reject(new ModelBackendError('cli_invalid_output'));
			}
			if (result?.is_error !== false) return reject(new ModelBackendError('cli_error_result'));
			const output = result.structured_output;
			if (!output || typeof output !== 'object' || Array.isArray(output)) {
				return reject(new ModelBackendError('cli_no_structured_output'));
			}
			resolve(output);
		});
		child.stdin.end(prompt);
	});
}

function anthropicCompleter({ model, env, timeoutMs, effort, maxTokens }) {
	let sdk;
	return async ({ system, prompt, schema }) => {
		if (!sdk) {
			// Loaded only for this backend, so the default `claude` path needs no installed dependency.
			const { default: Anthropic } = await import('@anthropic-ai/sdk');
			sdk = {
				Anthropic,
				client: new Anthropic({
					...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
					timeout: timeoutMs,
					maxRetries: ANTHROPIC_MAX_RETRIES,
				}),
			};
		}
		let response;
		try {
			response = await sdk.client.beta.messages.create({
				model,
				max_tokens: maxTokens,
				system,
				messages: [{ role: 'user', content: prompt }],
				output_config: { effort, format: { type: 'json_schema', schema } },
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
			});
		} catch (error) {
			throw new ModelBackendError(anthropicFailureCode(sdk.Anthropic, error));
		}
		if (response.stop_reason !== 'end_turn') throw new ModelBackendError(`anthropic_stop_${response.stop_reason}`);
		const text = response.content.find((block) => block.type === 'text')?.text;
		try {
			return JSON.parse(text);
		} catch {
			throw new ModelBackendError('anthropic_invalid_output');
		}
	};
}

function anthropicFailureCode(Anthropic, error) {
	if (error instanceof Anthropic.APIConnectionTimeoutError) return 'anthropic_timeout';
	if (error instanceof Anthropic.APIConnectionError) return 'anthropic_connection';
	if (error instanceof Anthropic.AuthenticationError) return 'anthropic_auth';
	if (error instanceof Anthropic.APIError && Number.isInteger(error.status)) return `anthropic_http_${error.status}`;
	return 'anthropic_failed';
}
