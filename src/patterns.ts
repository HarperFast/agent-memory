import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isScopeLabel } from './scopes.ts';

export type ContentCheckMode = 'off' | 'flag';

interface NameEntry {
	readonly rest: readonly string[];
	readonly label: string;
}

export interface CustomerMatcher {
	/** First token of a name → the remaining tokens and the `customer:<org>` label. */
	readonly names: ReadonlyMap<string, readonly NameEntry[]>;
	readonly hosts: ReadonlyArray<{ readonly label: string; readonly regex: RegExp }>;
}

export interface ContentCheckSettings {
	readonly mode: ContentCheckMode;
	readonly model?: string;
	readonly matcher: CustomerMatcher;
}

export type SecretsSource = () => Readonly<Record<string, string | undefined>> | undefined;

const MAX_HOST_PATTERNS = 64;
const MAX_HOST_PATTERN_CHARS = 512;
const MAX_NAMES = 50_000;
const MAX_NAME_CHARS = 200;
const HOST_LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
const CHECK_FIELDS = ['mode', 'model', 'patterns'];
const PATTERN_FIELDS = ['namesFile', 'namesSecret', 'hosts'];
const HOST_FIELDS = ['label', 'regex'];

export const CONTENT_CHECK_OFF: ContentCheckSettings = Object.freeze({
	mode: 'off',
	matcher: Object.freeze({ names: new Map(), hosts: [] }),
});

// Every message names the option and nothing it holds: the names list is sensitive, and JSON.parse and RegExp
// errors quote their input, so neither is chained as a cause.
function fail(message: string): never {
	throw new Error(`@harperfast/agent-memory: customerContentCheck${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function tokens(text: string): string[] {
	return (
		text
			.normalize('NFKC')
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

function compileNames(source: string): Map<string, NameEntry[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		fail(' names source is not valid JSON');
	}
	if (!isPlainObject(parsed)) fail(' names source must be a JSON object of organization keys to arrays of names');
	const index = new Map<string, NameEntry[]>();
	let count = 0;
	for (const [org, names] of Object.entries(parsed)) {
		const label = `customer:${org}`;
		if (!isScopeLabel(label)) fail(' names source has an organization key that does not form a customer:<org> label');
		if (!Array.isArray(names) || names.length === 0) {
			fail(' names source must map each organization key to a non-empty array of names');
		}
		for (const name of names) {
			if (typeof name !== 'string' || name.length > MAX_NAME_CHARS) {
				fail(` names source names must be strings of at most ${MAX_NAME_CHARS} characters`);
			}
			const [first, ...rest] = tokens(name);
			if (first === undefined) fail(' names source names must contain a letter or digit');
			if (++count > MAX_NAMES) fail(` names source holds more than ${MAX_NAMES} names`);
			let entries = index.get(first);
			if (!entries) index.set(first, (entries = []));
			entries.push({ rest, label });
		}
	}
	return index;
}

function compileHosts(value: unknown): Array<{ label: string; regex: RegExp }> {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_HOST_PATTERNS) {
		fail(`.patterns.hosts must be an array of at most ${MAX_HOST_PATTERNS} { label, regex } entries`);
	}
	return value.map((entry, i) => {
		if (!isPlainObject(entry) || Object.keys(entry).some((key) => !HOST_FIELDS.includes(key))) {
			fail(`.patterns.hosts[${i}] must be { label, regex }`);
		}
		const { label, regex } = entry;
		if (typeof label !== 'string' || !HOST_LABEL.test(label)) {
			fail(`.patterns.hosts[${i}].label must be 1-64 characters of A-Z, a-z, 0-9, _, . or -`);
		}
		if (typeof regex !== 'string' || !regex || regex.length > MAX_HOST_PATTERN_CHARS) {
			fail(`.patterns.hosts[${i}].regex must be a non-empty string of at most ${MAX_HOST_PATTERN_CHARS} characters`);
		}
		try {
			return { label, regex: new RegExp(regex, 'iu') };
		} catch {
			fail(`.patterns.hosts[${i}].regex is not a valid regular expression`);
		}
	});
}

function readNames(patterns: Record<string, unknown>, secrets: SecretsSource): string | undefined {
	const { namesFile, namesSecret } = patterns;
	if (namesFile != null && namesSecret != null) fail('.patterns.namesFile and namesSecret are exclusive');
	if (namesFile != null) {
		// Absolute only: a path relative to the application would invite a names file inside its repository.
		if (typeof namesFile !== 'string' || !isAbsolute(namesFile)) fail('.patterns.namesFile must be an absolute path');
		try {
			return readFileSync(namesFile, 'utf8');
		} catch {
			fail('.patterns.namesFile could not be read');
		}
	}
	if (namesSecret != null) {
		if (typeof namesSecret !== 'string' || !namesSecret) fail('.patterns.namesSecret must be a secret name');
		const value = secrets()?.[namesSecret];
		if (typeof value !== 'string') fail('.patterns.namesSecret is not available to this application');
		return value;
	}
	return undefined;
}

export function parseContentCheck(options: unknown, secrets: SecretsSource): ContentCheckSettings {
	if (options === undefined || options === null) return CONTENT_CHECK_OFF;
	if (!isPlainObject(options) || Object.keys(options).some((key) => !CHECK_FIELDS.includes(key))) {
		fail(' must be an object of mode, model and patterns');
	}
	const { mode = 'flag', model, patterns = {} } = options;
	if (mode !== 'off' && mode !== 'flag') fail('.mode must be off or flag');
	if (model !== undefined && model !== null && (typeof model !== 'string' || !model)) {
		fail('.model must be a non-empty model name');
	}
	if (!isPlainObject(patterns) || Object.keys(patterns).some((key) => !PATTERN_FIELDS.includes(key))) {
		fail('.patterns must be an object of namesFile or namesSecret, and hosts');
	}
	if (mode === 'off') return CONTENT_CHECK_OFF;
	const hosts = compileHosts(patterns.hosts);
	const source = readNames(patterns, secrets);
	return Object.freeze({
		mode,
		...(model ? { model: model as string } : {}),
		matcher: Object.freeze({ names: source === undefined ? new Map() : compileNames(source), hosts }),
	});
}

/** The text the check reads: every author-written field, including evidence refs (a URL names its host). */
export function checkedText(fields: {
	title?: string | null;
	content?: string | null;
	tags?: readonly string[] | null;
	evidence?: ReadonlyArray<{ ref: string; note?: string | null }> | null;
}): string {
	return [
		fields.title ?? '',
		fields.content ?? '',
		...(fields.tags ?? []),
		...(fields.evidence ?? []).flatMap((item) => [item.ref, item.note ?? '']),
	].join('\n');
}

/** Sorted labels: `customer:<org>` per matched name, the configured label per matched host pattern. */
export function matchCustomerContent(text: string, matcher: CustomerMatcher): string[] {
	const labels = new Set<string>();
	if (matcher.names.size > 0) {
		const words = tokens(text);
		for (let i = 0; i < words.length; i++) {
			const entries = matcher.names.get(words[i]);
			if (!entries) continue;
			for (const { rest, label } of entries) {
				if (!labels.has(label) && rest.every((word, j) => words[i + 1 + j] === word)) labels.add(label);
			}
		}
	}
	for (const { label, regex } of matcher.hosts) {
		if (!labels.has(label) && regex.test(text)) labels.add(label);
	}
	return [...labels].sort();
}
