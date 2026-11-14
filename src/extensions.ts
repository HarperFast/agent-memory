import { logger } from 'harper';
import { domain, noteExtensionRegistered, noteRegistration } from './runtime.ts';
import type { Principal } from './scopes.ts';
import { VIEW_FIELDS } from './search.ts';

export interface BootstrapItem {
	title?: string;
	content: string;
}

export interface BootstrapRenderInput {
	readonly principal: Principal;
	readonly q: string | undefined;
	/** Title + content room for one item: the budget left, net of one item's overhead. */
	readonly budgetChars: number;
	/** Charged per item on top of its title + content; a section returning several items spends it for each beyond the first. */
	readonly itemOverheadChars: number;
	readonly context: object;
}

export type BootstrapSectionOutput = { text: string } | readonly BootstrapItem[] | null | undefined;

export interface BootstrapSection {
	readonly name: string;
	render(input: BootstrapRenderInput): BootstrapSectionOutput | Promise<BootstrapSectionOutput>;
}

export interface SearchAnnotateInput {
	readonly principal: Principal;
	readonly hits: readonly Readonly<Record<string, unknown>>[];
	readonly context: object;
}

export type SearchAnnotations = ReadonlyMap<string, unknown> | null | undefined;

export interface SearchAnnotator {
	readonly name: string;
	annotate(input: SearchAnnotateInput): SearchAnnotations | Promise<SearchAnnotations>;
}

type SearchHit = Record<string, unknown> & { id: string };

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BUILT_IN_SECTIONS = ['pinned', 'needsReview', 'recent', 'relevant'];
const FAILURE_LOG_INTERVAL_MS = 60_000;
const lastFailureLog = new Map<string, number>();

// Stores a frozen copy, so the name checked here is the name dispatch uses.
function register<T extends { readonly name: string }>(
	list: T[],
	entry: T,
	kind: string,
	method: 'render' | 'annotate',
	reserved: readonly string[],
): () => void {
	const name = entry?.name;
	const fn = (entry as any)?.[method];
	if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
		throw new TypeError(`@harperfast/agent-memory: a ${kind} name must match ${NAME_PATTERN}`);
	}
	if (typeof fn !== 'function') {
		throw new TypeError(`@harperfast/agent-memory: ${kind} "${name}" needs a ${method} function`);
	}
	if (reserved.includes(name)) throw new TypeError(`@harperfast/agent-memory: ${kind} name "${name}" is reserved`);
	if (list.some((other) => other.name === name)) {
		throw new TypeError(`@harperfast/agent-memory: ${kind} "${name}" is already registered`);
	}
	noteRegistration();
	const registered = Object.freeze({ name, [method]: fn.bind(entry) }) as unknown as T;
	list.push(registered);
	noteExtensionRegistered();
	return () => {
		const index = list.indexOf(registered);
		if (index !== -1) list.splice(index, 1);
	};
}

/**
 * Adds a section to `GET /Memory/bootstrap` after `pinned` and `needsReview` and before `recent`, rendered per
 * caller. Its items pack into the caller's budget like memories; a throwing section is omitted and logged. Returns
 * an unregister function. Contract: DESIGN.md, Extension points.
 */
export function registerBootstrapSection(section: BootstrapSection): () => void {
	const target = domain();
	return register((target.bootstrapSections ??= []), section, 'bootstrap section', 'render', BUILT_IN_SECTIONS);
}

/**
 * Attaches per-hit data to hybrid search results (REST `q` searches and MCP `recall` with `q`) under the
 * annotator's name. It cannot add, remove or reorder hits, and must not change them; a throwing annotator is skipped
 * and logged.
 * Returns an unregister function. Contract: DESIGN.md, Extension points.
 */
export function registerSearchAnnotator(annotator: SearchAnnotator): () => void {
	const target = domain();
	return register((target.searchAnnotators ??= []), annotator, 'search annotator', 'annotate', [
		...VIEW_FIELDS,
		'score',
	]);
}

function reportFailure(kind: string, name: string, error: unknown): void {
	const key = `${kind}:${name}`;
	const now = Date.now();
	if (now - (lastFailureLog.get(key) ?? -Infinity) < FAILURE_LOG_INTERVAL_MS) return;
	lastFailureLog.set(key, now);
	try {
		logger.error?.(`[agent-memory] ${kind} "${name}" failed and was left out of the response`, error);
	} catch {}
}

const NO_SECTIONS: readonly BootstrapSection[] = Object.freeze([]);

/** The sections registered now; one registered or unregistered later takes effect from the next bootstrap. */
export function registeredBootstrapSections(): readonly BootstrapSection[] {
	const sections = domain().bootstrapSections;
	return sections?.length ? sections.slice() : NO_SECTIONS;
}

function bootstrapItems(output: unknown): BootstrapItem[] {
	if (output === null || output === undefined) return [];
	let list: readonly any[];
	if (Array.isArray(output)) list = output;
	else if (typeof (output as any).text === 'string') list = [{ content: (output as any).text }];
	else throw new TypeError('render must return { text }, an array of { title?, content }, or nothing');
	return list.map((item) => {
		const { title, content } = item ?? {};
		if (typeof content !== 'string' || (title !== undefined && typeof title !== 'string')) {
			throw new TypeError('a bootstrap item must be { title?: string, content: string }');
		}
		return title === undefined ? { content } : { title, content };
	});
}

export function renderBootstrapSections(
	sections: readonly BootstrapSection[],
	input: BootstrapRenderInput,
): Promise<{ name: string; items: BootstrapItem[] }[]> {
	const shared = Object.freeze({ ...input });
	return Promise.all(
		sections.map(async (section) => {
			const name = section.name;
			try {
				return { name, items: bootstrapItems(await section.render(shared)) };
			} catch (error) {
				reportFailure('bootstrap section', name, error);
				return { name, items: [] };
			}
		}),
	);
}

async function runAnnotators(
	annotators: readonly SearchAnnotator[],
	hits: SearchHit[],
	principal: Principal,
	context: object,
): Promise<void> {
	// Each annotator sees a frozen copy of the list, so none can add, drop or reorder hits for the response or the others.
	const input = Object.freeze({ principal, hits: Object.freeze(hits.slice()), context });
	const results = await Promise.all(
		annotators.map(async (annotator) => {
			const name = annotator.name;
			try {
				const annotations = await annotator.annotate(input);
				if (annotations === null || annotations === undefined) return undefined;
				return { name, values: hits.map((hit) => annotations.get(hit.id)) };
			} catch (error) {
				reportFailure('search annotator', name, error);
				return undefined;
			}
		}),
	);
	for (const result of results) {
		if (result === undefined) continue;
		hits.forEach((hit, index) => {
			if (result.values[index] !== undefined) hit[result.name] = result.values[index];
		});
	}
}

export function annotateSearchHits(hits: SearchHit[], principal: Principal, context: object): void | Promise<void> {
	const annotators = domain().searchAnnotators;
	if (!annotators?.length || hits.length === 0) return;
	return runAnnotators(annotators.slice(), hits, principal, context);
}
