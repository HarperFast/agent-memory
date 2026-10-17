// In-memory stand-in for the parts of the `harper` package the plugin uses. Transactions snapshot every
// table, commit only when the callback resolves, and run one at a time — the serialization the plugin gets
// from Harper's record locks — so rollback and stale-revision behavior are observable. Inside a transaction
// `get` sees its own writes but `search` sees only committed rows, as Harper's indexes do. Records come back
// frozen, as Harper's do, so a module that mutates a read record fails here too.

let clock = 0;
const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000);

function cosineDistance(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const tokens = (text) =>
	String(text ?? '')
		.toLowerCase()
		.match(/[a-z0-9]+/g) ?? [];

export function embedText(text, dimensions = 32) {
	const vector = new Array(dimensions).fill(0);
	vector[0] = 0.01;
	for (const token of tokens(text)) {
		let hash = 0;
		for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
		vector[1 + (hash % (dimensions - 1))] += 1;
	}
	return vector;
}

function matchesCondition(record, condition) {
	if (condition.conditions) {
		const results = condition.conditions.map((child) => matchesCondition(record, child));
		return condition.operator === 'or' ? results.some(Boolean) : results.every(Boolean);
	}
	const comparator = condition.comparator ?? 'equals';
	if (comparator.startsWith('matches')) {
		const wanted = tokens(condition.value);
		const have = new Set([...tokens(record.title), ...tokens(record.content)]);
		return wanted.some((token) => have.has(token));
	}
	const test = (value) => {
		switch (comparator) {
			case 'equals':
				return value === condition.value;
			case 'not_equal':
				return value !== condition.value;
			case 'greater_than':
				return value instanceof Date && condition.value instanceof Date
					? value.getTime() > condition.value.getTime()
					: value !== null && value !== undefined && value > condition.value;
			case 'gelt':
				return value >= condition.value[0] && value < condition.value[1];
			default:
				throw new Error(`stub: unsupported comparator ${comparator}`);
		}
	};
	const value = record[condition.attribute];
	return Array.isArray(value) ? value.some(test) : test(value);
}

const stores = new Map();
const searchLog = [];
const lockLog = [];
const setEmbedCalls = [];

class StubTable {
	constructor(name) {
		this.name = name;
		this.embedders = {};
		stores.set(name, new Map());
	}
	#rows(context) {
		return context?.transaction?.rows.get(this.name) ?? stores.get(this.name);
	}
	setEmbedAttribute(attribute, embedder) {
		this.embedders[attribute] = embedder;
		setEmbedCalls.push({ table: this.name, attribute });
	}
	async lock(id, options, context) {
		lockLog.push({ table: this.name, id, inTransaction: Boolean(context?.transaction) });
	}
	async #embed(record) {
		if (!('content' in record)) return;
		const embedder = this.embedders.embedding;
		record.embedding = embedder ? await embedder(record, {}) : embedText(record.content);
	}
	async get(id, context) {
		const row = this.#rows(context).get(id);
		// Harper answers a missing id with null.
		return row ? Object.freeze(structuredClone(row)) : null;
	}
	async put(record, context) {
		const rows = this.#rows(context);
		const next = structuredClone(record);
		await this.#embed(next);
		next.createdAt ??= rows.get(record.id)?.createdAt ?? stamp();
		if (this.name !== 'MemoryPin') next.updatedAt = stamp();
		rows.set(record.id, next);
	}
	async patch(id, changes, context) {
		const rows = this.#rows(context);
		const next = { ...rows.get(id), ...structuredClone(changes) };
		await this.#embed(changes.content === undefined ? {} : next);
		next.updatedAt = stamp();
		rows.set(id, next);
	}
	async delete(id, context) {
		return this.#rows(context).delete(id);
	}
	search(query, context) {
		searchLog.push({ table: this.name, query });
		const combine = query.operator === 'or' ? 'some' : 'every';
		const committed = stores.get(this.name);
		let results = [...committed.values()].filter((record) =>
			(query.conditions ?? [])[combine]((condition) => matchesCondition(record, condition)),
		);
		const sort = query.sort;
		if (sort?.target) {
			// Harper checks the target against the index's dimensions, whatever the conditions select.
			const stored = [...committed.values()].find((record) => Array.isArray(record[sort.attribute]));
			if (stored && stored[sort.attribute].length !== sort.target.length) {
				throw Object.assign(
					new Error(
						`Search target has ${sort.target.length} components, but this index stores ${stored[sort.attribute].length}.`,
					),
					{ statusCode: 400 },
				);
			}
			results = results
				.filter((record) => Array.isArray(record[sort.attribute]))
				.map((record) => ({ ...record, $distance: cosineDistance(record[sort.attribute], sort.target) }))
				.sort((a, b) => a.$distance - b.$distance);
		} else if (sort?.attribute) {
			const direction = sort.descending ? -1 : 1;
			results.sort((a, b) => (a[sort.attribute] > b[sort.attribute] ? direction : -direction));
		}
		results = results.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? Infinity));
		return (async function* () {
			for (const record of results) yield Object.freeze(structuredClone(record));
		})();
	}
}

export const databases = {
	memory: {
		Memory: new StubTable('Memory'),
		MemoryPin: new StubTable('MemoryPin'),
		ScopeGrant: new StubTable('ScopeGrant'),
	},
};
export const tables = {};

let chain = Promise.resolve();

export function transaction(contextOrCallback, maybeCallback) {
	const context = typeof contextOrCallback === 'function' ? {} : (contextOrCallback ?? {});
	const callback = typeof contextOrCallback === 'function' ? contextOrCallback : maybeCallback;
	if (context.transaction) return callback(context.transaction);
	const run = chain.then(async () => {
		const rows = new Map([...stores].map(([name, entries]) => [name, new Map(entries)]));
		context.transaction = { rows };
		try {
			const result = await callback(context.transaction);
			for (const [name, entries] of rows) stores.set(name, entries);
			return result;
		} finally {
			delete context.transaction;
		}
	});
	chain = run.then(
		() => {},
		() => {},
	);
	return run;
}

export const models = {
	calls: [],
	generateCalls: [],
	// Tests install a deterministic generator: (input, options) => content string, or throw.
	generator: undefined,
	async embed(input, options) {
		this.calls.push({ input, options });
		const dimensions = options?.model === 'wide' ? 64 : 32;
		return (Array.isArray(input) ? input : [input]).map((text) => Float32Array.from(embedText(text, dimensions)));
	},
	async generate(input, options) {
		this.generateCalls.push({ input, options });
		if (!this.generator) throw new Error(`stub: no generative backend for model ${options?.model}`);
		return { content: await this.generator(input, options), finishReason: 'stop' };
	},
};

export const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, notify() {} };

export class Resource {
	static loadAsInstance = true;
	constructor(context) {
		this._context = context;
	}
	getContext() {
		return this._context;
	}
}

export const __test = {
	stores,
	searchLog,
	lockLog,
	setEmbedCalls,
	embedText,
	reset() {
		for (const entries of stores.values()) entries.clear();
		searchLog.length = 0;
		lockLog.length = 0;
		models.calls.length = 0;
		models.generateCalls.length = 0;
		models.generator = undefined;
	},
};
