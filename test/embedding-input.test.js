import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { __test, databases, logger, models } from 'harper';
import { MemoryImportResource, MemoryMcpResource, MemoryResource } from '../dist/resource.js';
import { applySettings, parseSettings } from '../dist/settings.js';

const aliceUser = { username: 'alice' };
const superUser = { username: 'root', role: { role: 'super_user', permission: { super_user: true } } };
const queryTarget = (query = '', params = {}) => Object.assign(new URLSearchParams(query), params);
const prose = (chars) => `${'word '.repeat(Math.ceil(chars / 5)).slice(0, chars - 1)}x`;

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

describe('embeddingTruncate', () => {
	// Stands in for a model with a 2,048-token window and a tokenizer that spends a token on every two characters,
	// which a backend asked to truncate cuts at the window, keeping the start.
	const WINDOW_TOKENS = 2_048;
	const tokensOf = (text) => Math.ceil(text.length / 2);
	let truncatedTo;

	beforeEach(() => {
		truncatedTo = [];
		models.embed = (input, options) => {
			const texts = Array.isArray(input) ? input : [input];
			sent.push({ texts, options });
			const over = texts.some((text) => tokensOf(text) > WINDOW_TOKENS);
			if (over && options.truncate !== true) {
				throw Object.assign(new Error("OpenAI /embeddings returned HTTP 400: This model's maximum context length"), {
					upstreamStatus: 400,
				});
			}
			const cut = texts.map((text) => text.slice(0, WINDOW_TOKENS * 2));
			truncatedTo.push(...cut.map((text) => text.length));
			return embed.call(models, cut, options);
		};
	});

	const hex = (chars) => {
		let out = '';
		for (let index = 0; out.length < chars; index++) out += ((index * 2654435761) >>> 0).toString(16).padStart(8, '0');
		return out.slice(0, chars);
	};
	const importRow = (n, content) => ({
		id: `imported-row-000${n}`,
		ownerId: 'root',
		content,
		scopes: ['global'],
		status: 'active',
	});

	it('embeds 10,000 characters of token-dense content when the backend truncates', async () => {
		applySettings(parseSettings({ embeddingTruncate: true, limits: { embeddingInputChars: 20_000 } }));
		const content = hex(10_000);
		const remembered = await new MemoryMcpResource().mcpRemember(
			{ title: 'hex dump', content, visibility: 'shared' },
			{ user: aliceUser },
		);
		assert.equal(remembered.created, true);
		assert.equal(storedContent(remembered.id), content);
		assert.deepEqual(sent.at(-1), {
			texts: [content],
			options: { model: 'default', inputType: 'document', truncate: true },
		});
		assert.deepEqual(truncatedTo, [WINDOW_TOKENS * 2]);
	});

	it('fails the same write when the setting is off, so the cap is all that bounds the input', async () => {
		applySettings(parseSettings({ limits: { embeddingInputChars: 20_000 } }));
		await assert.rejects(
			new MemoryMcpResource().mcpRemember({ title: 'hex dump', content: hex(10_000) }, { user: aliceUser }),
		);
		assert.deepEqual(sent.at(-1).options, { model: 'default', inputType: 'document' });
	});

	it('asks for truncation on remember, revise, import, the table hook and search', async () => {
		applySettings(parseSettings({ mcp: true, embeddingTruncate: true }));
		const resource = new MemoryMcpResource();
		const { id } = await resource.mcpRemember(
			{ title: 't', content: 'first', visibility: 'shared' },
			{ user: aliceUser },
		);
		await resource.mcpRevise({ id, revision: 1, content: 'second' }, { user: aliceUser });
		const response = await MemoryImportResource.post(
			queryTarget(''),
			{ rows: [importRow(1, 'imported')] },
			{ user: superUser },
		);
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		const signal = new AbortController().signal;
		await databases.memory.Memory.embedders.embedding({ content: 'hook', embeddingModel: 'default' }, { signal });
		const searched = await MemoryResource.get(queryTarget('q=first', { rest: '' }), { user: superUser });
		assert.equal(searched.status, 200);
		assert.deepEqual(
			sent.map(({ texts, options }) => [texts, options]),
			[
				[['first'], { model: 'default', inputType: 'document', truncate: true }],
				[['second'], { model: 'default', inputType: 'document', truncate: true }],
				[['imported'], { model: 'default', inputType: 'document', truncate: true }],
				[['hook'], { model: 'default', inputType: 'document', signal, truncate: true }],
				[['first'], { model: 'default', inputType: 'query', truncate: true }],
			],
		);
	});

	it('leaves every call as before when off', async () => {
		const resource = new MemoryMcpResource();
		const { id } = await resource.mcpRemember(
			{ title: 't', content: 'first', visibility: 'shared' },
			{ user: aliceUser },
		);
		await resource.mcpRevise({ id, revision: 1, content: 'second' }, { user: aliceUser });
		await MemoryImportResource.post(queryTarget(''), { rows: [importRow(1, 'imported')] }, { user: superUser });
		const signal = new AbortController().signal;
		await databases.memory.Memory.embedders.embedding({ content: 'hook', embeddingModel: 'default' }, { signal });
		await MemoryResource.get(queryTarget('q=first', { rest: '' }), { user: superUser });
		assert.deepEqual(
			sent.map(({ options }) => options),
			[
				{ model: 'default', inputType: 'document' },
				{ model: 'default', inputType: 'document' },
				{ model: 'default', inputType: 'document' },
				{ model: 'default', inputType: 'document', signal },
				{ model: 'default', inputType: 'query' },
			],
		);
	});

	it('does not ask a row recorded under another model to truncate in the table hook', async () => {
		applySettings(parseSettings({ embeddingTruncate: true }));
		await new MemoryMcpResource().mcpRemember({ title: 't', content: 'installs the hook' }, { user: aliceUser });
		const signal = new AbortController().signal;
		await databases.memory.Memory.embedders.embedding({ content: 'old row', embeddingModel: 'previous' }, { signal });
		assert.deepEqual(sent.at(-1), {
			texts: ['old row'],
			options: { model: 'previous', inputType: 'document', signal },
		});
	});

	it('keeps an import on the settings it started with when the configuration changes between batches', async () => {
		const started = { embeddingTruncate: true, limits: { contentChars: 60_000, embeddingInputChars: 60_000 } };
		applySettings(parseSettings(started));
		const truncating = models.embed;
		models.embed = (input, options) => {
			applySettings(parseSettings({ embeddingModel: 'reloaded', limits: started.limits }));
			return truncating(input, options);
		};
		const response = await MemoryImportResource.post(
			queryTarget(''),
			{ rows: [importRow(1, hex(60_000)), importRow(2, hex(60_000))] },
			{ user: superUser },
		);
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		assert.deepEqual(
			sent.map(({ texts, options }) => [texts.length, options]),
			[
				[1, { model: 'default', inputType: 'document', truncate: true }],
				[1, { model: 'default', inputType: 'document', truncate: true }],
			],
		);
	});
});

describe('embeddingTruncate on a backend that cannot truncate', () => {
	// Harper 5.4 refuses `truncate: true` for a backend without the capability before sending any request.
	const refusal = (backend = 'default', capability = 'truncate') =>
		Object.assign(new Error(`Backend '${backend}' does not support '${capability}'`), { name: 'ModelCapabilityError' });
	let warnings;
	let failWith;
	let truncates;
	const warn = logger.warn;

	beforeEach(() => {
		warnings = [];
		failWith = undefined;
		truncates = false;
		logger.warn = (...args) => warnings.push(args.join(' '));
		models.embed = (input, options) => {
			const texts = Array.isArray(input) ? input : [input];
			sent.push({ texts, options });
			if (options.truncate === true && !truncates) throw refusal();
			const failure = failWith?.(options);
			if (failure !== undefined) throw failure;
			if (texts.some((text) => text.length > limit)) {
				throw Object.assign(new Error("OpenAI /embeddings returned HTTP 400: This model's maximum context length"), {
					upstreamStatus: 400,
				});
			}
			return embed.call(models, texts, options);
		};
	});

	afterEach(() => {
		logger.warn = warn;
		mock.timers.reset();
	});

	const refusedModel = (name, limits = {}) =>
		applySettings(
			parseSettings({
				embeddingModel: name,
				embeddingTruncate: true,
				limits: { embeddingInputChars: 12_000, ...limits },
			}),
		);
	const optionsOf = (from = 0) =>
		sent.slice(from).map(({ texts, options }) => [texts[0].length, options.truncate === true]);

	it('commits the write, embedding the head cut to embeddingFallbackChars, and warns once', async () => {
		refusedModel('refused-write');
		const content = prose(20_000);
		const resource = new MemoryMcpResource();
		const remembered = await resource.mcpRemember(
			{ title: 'long', content, visibility: 'shared' },
			{ user: aliceUser },
		);
		assert.equal(remembered.created, true);
		assert.equal(storedContent(remembered.id), content);
		assert.deepEqual(sent, [
			{ texts: [content.slice(0, 12_000)], options: { model: 'refused-write', inputType: 'document', truncate: true } },
			{ texts: [content.slice(0, 4_000)], options: { model: 'refused-write', inputType: 'document' } },
		]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /embeddingModel "refused-write" cannot truncate/);
		assert.match(warnings[0], /Backend 'default' does not support 'truncate'/);
		assert.match(warnings[0], /first 4000 characters/);
		assert.match(warnings[0], /truncation: 'vllm'/);
		assert.match(warnings[0], /embeddingTruncate: false.*embeddingInputChars/);

		await resource.mcpRevise({ id: remembered.id, revision: 1, content: prose(9_000) }, { user: aliceUser });
		assert.deepEqual(optionsOf(2), [[4_000, false]]);
		assert.equal(warnings.length, 1);
	});

	it('falls back for an import batch and a search query, keeping the vector lane', async () => {
		refusedModel('refused-batch');
		const response = await MemoryImportResource.post(
			queryTarget(''),
			{
				rows: [
					{ id: 'imported-row-0001', ownerId: 'root', content: prose(15_000), scopes: ['global'], status: 'active' },
					{ id: 'imported-row-0002', ownerId: 'root', content: 'short', scopes: ['global'], status: 'active' },
				],
			},
			{ user: superUser },
		);
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		assert.deepEqual(
			sent.map(({ texts, options }) => [texts.map((text) => text.length), options.truncate === true]),
			[
				[[12_000, 5], true],
				[[4_000, 5], false],
			],
		);
		applySettings(
			parseSettings({
				embeddingModel: 'refused-query',
				embeddingTruncate: true,
				limits: { embeddingInputChars: 800, embeddingFallbackChars: 500 },
			}),
		);
		const q = prose(900);
		const searched = await MemoryResource.get(queryTarget(`q=${encodeURIComponent(q)}`, { rest: '' }), {
			user: superUser,
		});
		assert.equal(searched.status, 200);
		assert.deepEqual(optionsOf(2), [
			[800, true],
			[500, false],
		]);
		assert.equal(sent.at(-1).options.inputType, 'query');
		assert.ok(
			__test.searchLog.some(({ query }) => query.sort?.attribute === 'embedding'),
			'the vector lane ran',
		);
	});

	it('never sends more than embeddingInputChars on the fallback', async () => {
		refusedModel('refused-small-cap', { embeddingInputChars: 3_000, embeddingFallbackChars: 5_000 });
		await new MemoryMcpResource().mcpRemember({ title: 't', content: prose(9_000) }, { user: aliceUser });
		assert.deepEqual(optionsOf(), [
			[3_000, true],
			[3_000, false],
		]);
	});

	it('asks again five minutes after a refusal, from one caller at a time, and truncates once the backend can', async () => {
		mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 10) });
		refusedModel('rechecked');
		const resource = new MemoryMcpResource();
		await resource.mcpRemember({ title: 't', content: 'first' }, { user: aliceUser });
		const hook = (content) =>
			databases.memory.Memory.embedders.embedding({ content, embeddingModel: 'rechecked' }, { signal: undefined });
		mock.timers.tick(4 * 60_000);
		await hook('within the window');
		assert.deepEqual(optionsOf(2), [[17, false]]);

		mock.timers.tick(60_000 + 1);
		truncates = true;
		await Promise.all([hook('recheck one'), hook('recheck two')]);
		assert.deepEqual(
			sent.slice(3).map(({ options }) => options.truncate === true),
			[true, false],
		);
		await hook('after the recheck');
		assert.equal(sent.at(-1).options.truncate, true);
		assert.equal(warnings.length, 1);
	});

	it('keeps the downgrade when the recheck is refused again, without warning again', async () => {
		mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 10) });
		refusedModel('refused-again');
		const hook = (content) =>
			databases.memory.Memory.embedders.embedding({ content, embeddingModel: 'refused-again' }, { signal: undefined });
		await new MemoryMcpResource().mcpRemember({ title: 't', content: 'first' }, { user: aliceUser });
		mock.timers.tick(5 * 60_000 + 1);
		await hook('recheck');
		await hook('after');
		assert.deepEqual(
			sent.slice(2).map(({ options }) => options.truncate === true),
			[true, false, false],
		);
		assert.equal(warnings.length, 1);
	});

	it('asks again after a configuration reload', async () => {
		refusedModel('reloaded');
		const resource = new MemoryMcpResource();
		await resource.mcpRemember({ title: 't', content: 'first' }, { user: aliceUser });
		refusedModel('reloaded');
		await resource.mcpRemember({ title: 't', content: 'second' }, { user: aliceUser });
		assert.deepEqual(
			sent.map(({ options }) => options.truncate === true),
			[true, false, true, false],
		);
	});

	it('fails the write as before on a real backend failure, without retrying or downgrading', async () => {
		const failures = [
			Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') }),
			Object.assign(new Error('OpenAI /embeddings returned HTTP 503'), { upstreamStatus: 503 }),
			refusal('default', 'embed'),
			Object.assign(new Error("Backend 'default' does not support 'truncate'"), { name: 'Error' }),
			null,
		];
		applySettings(parseSettings({ embeddingTruncate: true }));
		truncates = true;
		for (const failure of failures) {
			failWith = () => failure;
			sent = [];
			const before = __test.stores.get('Memory').size;
			await assert.rejects(new MemoryMcpResource().mcpRemember({ title: 't', content: 'x' }, { user: aliceUser }));
			assert.equal(sent.length, 1, String(failure?.message));
			assert.equal(__test.stores.get('Memory').size, before);
		}
		assert.deepEqual(
			warnings.filter((warning) => /truncate/.test(warning)),
			[],
		);
	});

	it('surfaces a failure of the fallback call itself', async () => {
		refusedModel('down-after-refusal');
		failWith = (options) =>
			options.truncate === true ? undefined : Object.assign(new TypeError('fetch failed'), { cause: 'ECONNREFUSED' });
		await assert.rejects(new MemoryMcpResource().mcpRemember({ title: 't', content: 'x' }, { user: aliceUser }));
		assert.equal(sent.length, 2);
		assert.equal(__test.stores.get('Memory').size, 0);
	});

	it('passes the table hook signal to both attempts', async () => {
		refusedModel('signalled');
		await new MemoryMcpResource().mcpRemember({ title: 't', content: 'installs the hook' }, { user: aliceUser });
		sent = [];
		applySettings(parseSettings({ embeddingModel: 'signalled', embeddingTruncate: true }));
		const signal = new AbortController().signal;
		await databases.memory.Memory.embedders.embedding({ content: 'hook', embeddingModel: 'signalled' }, { signal });
		assert.deepEqual(
			sent.map(({ options }) => options),
			[
				{ model: 'signalled', inputType: 'document', signal, truncate: true },
				{ model: 'signalled', inputType: 'document', signal },
			],
		);
	});
});
