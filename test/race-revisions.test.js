import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { run } from '../scripts/race-revisions.mjs';

const ENV = { AGENT_MEMORY_AUTHORIZATION: 'Bearer race-token' };

/** Two nodes over one store whose conditional PUT is atomic: the behavior cluster-scoped locks give. */
function fakeCluster() {
	const cluster = { memories: new Map(), requests: [] };
	cluster.handle = async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const url = new URL(request.url, 'http://localhost');
		const id = url.pathname.split('/')[2];
		const ifMatch = request.headers['if-match'];
		cluster.requests.push({ method: request.method, ifMatch, authorization: request.headers.authorization });
		const memory = cluster.memories.get(id);
		let status = 200;
		let json;
		if (request.method === 'GET') {
			if (memory) json = { memory };
			else status = 404;
		} else if (request.method === 'PUT' && !memory) {
			cluster.memories.set(id, { id, revision: 1, content: JSON.parse(body).content });
			status = 201;
			json = { id, revision: 1 };
		} else if (ifMatch !== `"${memory.revision}"`) {
			status = 412;
			json = { error: { code: 'precondition_failed' } };
		} else if (request.method === 'PUT') {
			memory.revision++;
			memory.content = JSON.parse(body).content;
			json = { id, revision: memory.revision };
		} else {
			memory.revision++;
			json = { memory };
		}
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(json === undefined ? '' : JSON.stringify(json));
	};
	return cluster;
}

const capture = () => {
	const sink = { text: '', write: (chunk) => (sink.text += chunk) };
	return sink;
};

describe('scripts/race-revisions.mjs', () => {
	const cluster = fakeCluster();
	const servers = [createServer(cluster.handle), createServer(cluster.handle)];
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

	it('reports one success, convergence, and withdraws at the final revision', async () => {
		const stdout = capture();
		const code = await run(['--node', urls[0], '--node', urls[1], '--writers', '6'], ENV, {
			stdout,
			stderr: capture(),
		});
		assert.equal(code, 0);
		const report = JSON.parse(stdout.text);
		assert.deepEqual(report.statuses, { 200: 1, 412: 5 });
		assert.equal(report.converged, true);
		assert.deepEqual(report.final, [
			{ revision: 2, writer: report.final[0].writer },
			{ revision: 2, writer: report.final[0].writer },
		]);
		assert.equal(report.withdrawn, true);
		assert.ok(cluster.requests.every((request) => request.authorization === ENV.AGENT_MEMORY_AUTHORIZATION));
		assert.equal(cluster.requests.at(-1).ifMatch, '"2"');
	});

	it('needs two nodes and the authorization variable', async () => {
		assert.equal(await run(['--node', urls[0]], ENV, { stdout: capture(), stderr: capture() }), 2);
		assert.equal(await run(['--node', urls[0], '--node', urls[1]], {}, { stdout: capture(), stderr: capture() }), 2);
	});
});
