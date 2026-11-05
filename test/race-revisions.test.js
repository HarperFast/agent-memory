import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { run } from '../scripts/race-revisions.mjs';

const ENV = { AGENT_MEMORY_AUTHORIZATION: 'Bearer race-token' };

function fakeCluster() {
	const cluster = { memories: new Map(), requests: [] };
	cluster.reset = () => Object.assign(cluster, { revise: undefined, read: undefined, withdrawStatus: 200 });
	cluster.reset();
	cluster.handlerFor = (node) => async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const id = new URL(request.url, 'http://localhost').pathname.split('/')[2];
		const ifMatch = request.headers['if-match'];
		cluster.requests.push({ method: request.method, ifMatch, authorization: request.headers.authorization });
		const reply = (status, json) => {
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end(json === undefined ? '' : JSON.stringify(json));
		};
		const failure = (status) => reply(status, { error: 'failed', code: status === 412 ? 'precondition_failed' : 'x' });
		const memory = cluster.memories.get(id);
		if (request.method === 'GET') {
			if (!memory) return reply(404);
			return reply(200, { memory: cluster.read?.(node, memory) ?? memory });
		}
		if (request.method === 'PUT' && !memory) {
			cluster.memories.set(id, { id, revision: 1, content: JSON.parse(body).content });
			return reply(201, { id, revision: 1 });
		}
		if (request.method === 'DELETE') {
			if (cluster.withdrawStatus !== 200) return failure(cluster.withdrawStatus);
			if (ifMatch !== `"${memory.revision}"`) return failure(412);
			memory.revision++;
			return reply(200, { memory });
		}
		const content = JSON.parse(body).content;
		let status = cluster.revise?.({ memory, content, ifMatch });
		if (status === 'drop') return request.socket.destroy();
		if (status === undefined) {
			if (ifMatch !== `"${memory.revision}"`) return failure(412);
			memory.revision++;
			memory.content = content;
			status = 200;
		}
		if (status !== 200) return failure(status);
		return reply(200, { id, revision: memory.revision });
	};
	return cluster;
}

const capture = () => {
	const sink = { text: '', write: (chunk) => (sink.text += chunk) };
	return sink;
};

describe('scripts/race-revisions.mjs', () => {
	const cluster = fakeCluster();
	const servers = [createServer(cluster.handlerFor(0)), createServer(cluster.handlerFor(1))];
	let urls;
	before(async () => {
		urls = await Promise.all(
			servers.map(async (server) => {
				server.listen(0, '127.0.0.1');
				await once(server, 'listening');
				return `http://127.0.0.1:${server.address().port}`;
			}),
		);
	});
	after(() => servers.forEach((server) => server.close()));
	beforeEach(() => cluster.reset());

	async function race(writers = 6) {
		const stdout = capture();
		const stderr = capture();
		const code = await run(['--node', urls[0], '--node', urls[1], '--writers', String(writers)], ENV, {
			stdout,
			stderr,
			settleAttempts: 3,
		});
		return { code, report: stdout.text ? JSON.parse(stdout.text) : undefined, stderr: stderr.text };
	}

	it('passes on one winner whose content every node serves, and withdraws at the final revision', async () => {
		const { code, report } = await race();
		assert.equal(code, 0);
		assert.deepEqual(report.statuses, { 200: 1, 412: 5 });
		assert.deepEqual(report.problems, []);
		assert.equal(report.converged, true);
		const winner = `race writer ${report.succeeded[0].writer}`;
		assert.deepEqual(report.final, [
			{ revision: 2, writer: winner },
			{ revision: 2, writer: winner },
		]);
		assert.equal(report.withdrawn, true);
		assert.ok(cluster.requests.every((request) => request.authorization === ENV.AGENT_MEMORY_AUTHORIZATION));
		assert.equal(cluster.requests.at(-1).ifMatch, '"2"');
	});

	it('fails a double commit even though the nodes converge', async () => {
		let commits = 0;
		cluster.revise = ({ memory, content, ifMatch }) => {
			if (ifMatch !== '"1"' || commits === 2) return 412;
			commits++;
			memory.revision = 2;
			memory.content = content;
			return 200;
		};
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.statuses, { 200: 2, 412: 4 });
		assert.equal(report.converged, true);
		assert.deepEqual(report.problems, ['2 revisions succeeded, expected exactly 1']);
	});

	it('fails when no revision succeeds', async () => {
		cluster.revise = () => 412;
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.problems, ['0 revisions succeeded, expected exactly 1']);
		assert.deepEqual(report.final, [
			{ revision: 1, writer: 'race seed' },
			{ revision: 1, writer: 'race seed' },
		]);
	});

	it('fails when a loser answers 503 or no response instead of 412', async () => {
		let arrivals = 0;
		cluster.revise = () => {
			arrivals++;
			return arrivals === 2 ? 503 : arrivals === 3 ? 'drop' : undefined;
		};
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.statuses, { 0: 1, 200: 1, 412: 3, 503: 1 });
		assert.deepEqual(report.problems, ['2 revisions answered neither 200 nor 412']);
	});

	it("fails when the nodes converge on content other than the winner's", async () => {
		cluster.revise = ({ memory, ifMatch }) => {
			if (ifMatch !== `"${memory.revision}"`) return 412;
			memory.revision++;
			memory.content = 'race writer 99';
			return 200;
		};
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.problems, [
			`the nodes converged on content other than writer ${report.succeeded[0].writer}'s`,
		]);
	});

	it('fails when the nodes converge past the next revision', async () => {
		cluster.revise = ({ memory, content, ifMatch }) => {
			if (ifMatch !== `"${memory.revision}"`) return 412;
			memory.revision += 2;
			memory.content = content;
			return 200;
		};
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.problems, ['the nodes converged on revision 3, expected 2']);
	});

	it('fails when a node keeps serving the seed', async () => {
		cluster.read = (node, memory) => (node === 1 ? { ...memory, revision: 1, content: 'race seed' } : undefined);
		const { code, report } = await race();
		assert.equal(code, 1);
		assert.equal(report.converged, false);
		assert.deepEqual(report.problems, ['the nodes did not converge']);
		assert.deepEqual(report.final[1], { revision: 1, writer: 'race seed' });
	});

	it('keeps the report when the withdrawal fails', async () => {
		cluster.withdrawStatus = 503;
		const { code, report, stderr } = await race();
		assert.equal(code, 1);
		assert.deepEqual(report.problems, []);
		assert.equal(report.withdrawn, false);
		assert.match(stderr, /withdrawing race-.+ failed: HTTP 503/);
	});

	it('needs two distinct nodes and the authorization variable', async () => {
		assert.equal(await run(['--node', urls[0]], ENV, { stdout: capture(), stderr: capture() }), 2);
		const stderr = capture();
		assert.equal(await run(['--node', urls[0], '--node', `${urls[0]}/`], ENV, { stdout: capture(), stderr }), 2);
		assert.match(stderr.text, /pass each --node once/);
		assert.equal(await run(['--node', urls[0], '--node', urls[1]], {}, { stdout: capture(), stderr: capture() }), 2);
	});
});
