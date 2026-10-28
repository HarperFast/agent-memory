#!/usr/bin/env node
// Nothing reaches stdout or stderr but ids, revisions, statuses and codes: credentials stay out.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assertSafeUrl, isEntryPoint, UsageError } from './lib/cli.mjs';
import { createClient, pause, requestError } from './lib/memory-api.mjs';

const AUTHORIZATION = 'AGENT_MEMORY_AUTHORIZATION';
const MAX_WRITERS = 200;
const SETTLE_ATTEMPTS = 40;

const OPTIONS = {
	node: { type: 'string', multiple: true, default: [] },
	writers: { type: 'string', default: '20' },
	keep: { type: 'boolean', default: false },
	help: { type: 'boolean', default: false },
};

const USAGE = `Usage: node scripts/race-revisions.mjs --node <url> --node <url> [--writers <2-${MAX_WRITERS}>] [--keep]

Creates a private memory, waits until every node serves its first revision, then sends --writers concurrent
revisions with If-Match on that revision, spread round-robin across the nodes. With lockScope: cluster on a cluster
that has replication.recordLocks on, exactly one revision succeeds and the rest answer 412; with lockScope: node,
revisions sent to different nodes can each succeed. Waits for the nodes to agree on the result, then withdraws the
memory unless --keep. Exits 0 when exactly one revision succeeded and every node converged on it.

Environment: ${AUTHORIZATION}: the Authorization header value (for example "Basic <base64>" or
"Bearer <token>") of a user that can write memories on every node.
`;

async function revisionOn(request, id) {
	const result = await request('GET', `Memory/${id}`);
	if (result.status === 404) return undefined;
	if (result.status !== 200) throw requestError(`reading ${id}`, result);
	return { revision: result.json.memory.revision, content: result.json.memory.content };
}

/** Polls every node until all of them return the same state and `accept` holds for it. */
async function settle(requests, id, accept) {
	let states;
	for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
		states = await Promise.all(requests.map((request) => revisionOn(request, id)));
		const [first] = states;
		if (
			first &&
			accept(first) &&
			states.every((state) => state?.revision === first.revision && state.content === first.content)
		) {
			return { converged: true, states };
		}
		await pause(1);
	}
	return { converged: false, states };
}

export async function run(argv, env, { stdout = process.stdout, stderr = process.stderr } = {}) {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) {
			stdout.write(USAGE);
			return 0;
		}
		if (values.node.length < 2) throw new UsageError('pass --node at least twice');
		const nodes = values.node.map((node, index) => assertSafeUrl(node, `--node ${index + 1}`));
		const writers = Number(values.writers);
		if (!Number.isInteger(writers) || writers < 2 || writers > MAX_WRITERS) {
			throw new UsageError(`--writers must be an integer between 2 and ${MAX_WRITERS}`);
		}
		const authorization = env[AUTHORIZATION];
		if (!authorization) throw new UsageError(`set ${AUTHORIZATION} in the environment`);
		const requests = nodes.map((node) => createClient(node, authorization));

		const id = `race-${randomUUID()}`;
		const created = await requests[0]('PUT', `Memory/${id}`, {
			body: { title: 'record-lock race test', content: 'race seed' },
			headers: { 'If-None-Match': '*' },
		});
		if (created.status !== 201) throw requestError(`creating ${id}`, created);
		const seeded = await settle(requests, id, (state) => state.revision === created.json.revision);
		if (!seeded.converged) throw new Error(`${id} did not reach every node at revision ${created.json.revision}`);
		stderr.write(`${id} is at revision ${created.json.revision} on ${nodes.length} nodes\n`);

		const ifMatch = `"${created.json.revision}"`;
		const results = await Promise.all(
			Array.from({ length: writers }, (_, writer) =>
				requests[writer % requests.length]('PUT', `Memory/${id}`, {
					body: { content: `race writer ${writer}` },
					headers: { 'If-Match': ifMatch },
				}).then((result) => ({ writer, node: writer % requests.length, status: result.status, code: result.code })),
			),
		);
		const statuses = {};
		for (const { status } of results) statuses[status] = (statuses[status] ?? 0) + 1;
		const succeeded = results.filter((result) => result.status === 200);

		const final = await settle(requests, id, (state) => state.revision > created.json.revision);
		const report = {
			id,
			nodes: nodes.length,
			writers,
			statuses,
			succeeded: succeeded.map(({ writer, node }) => ({ writer, node })),
			converged: final.converged,
			final: final.states.map((state) => state && { revision: state.revision, writer: state.content }),
		};
		if (!values.keep) {
			const current = await revisionOn(requests[0], id);
			const withdrawn = await requests[0]('DELETE', `Memory/${id}?reason=race-test`, {
				headers: { 'If-Match': `"${current.revision}"` },
			});
			report.withdrawn = withdrawn.status === 200;
		}
		stdout.write(JSON.stringify(report, null, '\t') + '\n');
		return succeeded.length === 1 && final.converged ? 0 : 1;
	} catch (error) {
		stderr.write(`race-revisions: ${error.message}\n`);
		if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
			stderr.write(USAGE);
			return 2;
		}
		return 1;
	}
}

if (isEntryPoint(import.meta.filename)) process.exitCode = await run(process.argv.slice(2), process.env);
