import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases, models } from 'harper';
import { MemoryImportResource, MemoryMcpResource, MemoryResource } from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const aliceUser = { username: 'alice' };
const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };
const queryTarget = (query = '', params = {}) => Object.assign(new URLSearchParams(query), params);
const prose = (chars) => `${'word '.repeat(Math.ceil(chars / 5)).slice(0, chars - 1)}x`;

// Stands in for a backend whose context window holds `limit` characters, answering longer input as vLLM does.
let limit;
let sent;
const embed = models.embed;

beforeEach(async () => {
	__test.reset();
	limit = 6_000;
	sent = [];
	models.embed = (input, options) => {
		const texts = Array.isArray(input) ? input : [input];
		sent.push({ texts, options });
		if (texts.some((text) => text.length > limit)) {
			throw Object.assign(new Error("OpenAI /embeddings returned HTTP 400: This model's maximum context length"), {
				upstreamStatus: 400,
			});
		}
		return embed.call(models, input, options);
	};
	applySettings(parseSettings({ mcp: true }));
	await databases.memory.ScopeGrant.put({ id: 'user:alice', read: ['global'], write: ['global'] });
});

afterEach(() => {
	models.embed = embed;
});

const storedContent = (id) => __test.stores.get('Memory').get(id).content;

describe('embedding input bound', () => {
	it('remembers a memory of the full contentChars length, embedding its leading 6,000 characters by default', async () => {
		const content = prose(20_000);
		const remembered = await new MemoryMcpResource().mcpRemember(
			{ title: 'long', content, visibility: 'shared' },
			{ user: aliceUser },
		);
		assert.equal(remembered.created, true);
		assert.equal(storedContent(remembered.id), content);
		assert.deepEqual(
			sent.map(({ texts, options }) => [texts, options.model, options.inputType]),
			[[[content.slice(0, 6_000)], 'default', 'document']],
		);
	});

	it('revises a memory to long content', async () => {
		const resource = new MemoryMcpResource();
		const { id } = await resource.mcpRemember(
			{ title: 'short', content: 'short', visibility: 'shared' },
			{ user: aliceUser },
		);
		const content = prose(12_400);
		const revised = await resource.mcpRevise({ id, revision: 1, content }, { user: aliceUser });
		assert.equal(revised.revision, 2);
		assert.equal(storedContent(id), content);
		assert.deepEqual(sent.at(-1).texts, [content.slice(0, 6_000)]);
	});

	it('imports a batch holding a long row', async () => {
		applySettings(parseSettings({ limits: { embeddingInputChars: 1_000 } }));
		limit = 1_000;
		const row = (n, content) => ({
			id: `imported-row-000${n}`,
			ownerId: 'root',
			content,
			scopes: ['global'],
			status: 'active',
		});
		const long = prose(12_400);
		const response = await MemoryImportResource.post(
			queryTarget(''),
			{ rows: [row(1, 'short'), row(2, long), row(3, 'also short')] },
			{ user: superUser },
		);
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		assert.equal(storedContent('imported-row-0002'), long);
		assert.deepEqual(
			sent.map(({ texts }) => texts),
			[['short', long.slice(0, 1_000), 'also short']],
		);
	});

	it('embeds a row written without a vector through the table hook with the bound applied', async () => {
		applySettings(parseSettings({ limits: { embeddingInputChars: 100 } }));
		limit = 100;
		const content = prose(500);
		await new MemoryMcpResource().mcpRemember({ title: 't', content: 'installs the hook' }, { user: aliceUser });
		const signal = new AbortController().signal;
		const vector = await databases.memory.Memory.embedders.embedding({ content, embeddingModel: 'local' }, { signal });
		assert.ok(vector.length > 0);
		assert.deepEqual(sent.at(-1), {
			texts: [content.slice(0, 100)],
			options: { model: 'local', inputType: 'document', signal },
		});
	});

	it('searches with a query longer than the bound on both lanes, embedding only its head', async () => {
		applySettings(parseSettings({ limits: { embeddingInputChars: 500 } }));
		limit = 500;
		const q = prose(900);
		const response = await MemoryResource.get(queryTarget(`q=${encodeURIComponent(q)}`, { rest: '' }), {
			user: superUser,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(
			sent.map(({ texts, options }) => [texts, options.inputType]),
			[[[q.slice(0, 500)], 'query']],
		);
		const vectorLane = __test.searchLog.find(({ query }) => query.sort?.attribute === 'embedding');
		assert.ok(vectorLane, 'the vector lane ran');
		const textLane = __test.searchLog.find(({ query }) => query.conditions.some((c) => c.comparator === 'matches'));
		assert.equal(textLane.query.conditions.find((c) => c.comparator === 'matches').value, q);
	});
});
