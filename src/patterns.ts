import { readFileSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { isAbsolute } from 'node:path';
import { isScopeLabel } from './scopes.ts';

/** A trie over name tokens: matching costs the length of the longest name, not the size of the list. */
interface NameNode {
	labels?: Set<string>;
	next?: Map<string, NameNode>;
}

interface AddressRange {
	readonly label: string;
	readonly list: BlockList;
}

interface HostRules {
	readonly exact: ReadonlyMap<string, readonly string[]>;
	/** Keyed `.example.com` for the rule `*.example.com`. */
	readonly suffixes: ReadonlyMap<string, readonly string[]>;
	readonly ranges: readonly AddressRange[];
	/** Every range in one list, so an address outside all of them costs one check. */
	readonly anyRange: BlockList;
}

interface CustomerMatcher {
	readonly names: ReadonlyMap<string, NameNode>;
	readonly hosts: HostRules;
}

export interface ContentCheckSettings {
	readonly mode: 'off' | 'flag';
	readonly model?: string;
	readonly matcher: CustomerMatcher;
}

export type SecretsSource = () => Readonly<Record<string, string | undefined>> | undefined;

const MAX_HOST_PATTERNS = 256;
const MAX_NAMES = 50_000;
const MAX_NAME_CHARS = 200;
const MAX_HOST_NAME_CHARS = 253;
export const HOST_LABEL = /^[A-Za-z0-9_.-]{1,64}$/;
const DNS_LABEL = /^[a-z0-9-]{1,63}$/;
const CHECK_FIELDS = ['mode', 'model', 'patterns'];
const PATTERN_FIELDS = ['namesFile', 'namesSecret', 'hosts'];
const HOST_FIELDS = ['label', 'host', 'cidr'];

export const CONTENT_CHECK_OFF: ContentCheckSettings = Object.freeze({
	mode: 'off',
	matcher: Object.freeze({
		names: new Map(),
		hosts: { exact: new Map(), suffixes: new Map(), ranges: [], anyRange: new BlockList() },
	}),
});

// Every message names the option and nothing it holds: the names list is sensitive, and JSON.parse errors quote
// their input, so none is chained as a cause.
function fail(message: string): never {
	throw new Error(`@harperfast/agent-memory: customerContentCheck${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokens(text: string): string[] {
	return (
		text
			.normalize('NFKC')
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

function compileNames(source: string): Map<string, NameNode> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		fail(' names source is not valid JSON');
	}
	if (!isPlainObject(parsed)) fail(' names source must be a JSON object of organization keys to arrays of names');
	const root = new Map<string, NameNode>();
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
			const words = tokens(name);
			if (words.length === 0) fail(' names source names must contain a letter or digit');
			if (++count > MAX_NAMES) fail(` names source holds more than ${MAX_NAMES} names`);
			let level = root;
			let node: NameNode | undefined;
			for (const word of words) {
				node = level.get(word);
				if (!node) level.set(word, (node = {}));
				level = node.next ??= new Map();
			}
			(node!.labels ??= new Set()).add(label);
		}
	}
	return root;
}

function isHostName(name: string): boolean {
	const labels = name.split('.');
	return (
		name.length <= MAX_HOST_NAME_CHARS &&
		labels.length > 1 &&
		labels.every((label) => DNS_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'))
	);
}

function addLabel(index: Map<string, string[]>, key: string, label: string): void {
	let labels = index.get(key);
	if (!labels) index.set(key, (labels = []));
	labels.push(label);
}

// No operator-supplied regular expression: a host rule is an exact name or a `*.` suffix and an address rule a CIDR
// range, so matching stays linear in the text whatever is configured.
function compileHosts(value: unknown): HostRules {
	const rules = {
		exact: new Map<string, string[]>(),
		suffixes: new Map<string, string[]>(),
		ranges: [] as AddressRange[],
		anyRange: new BlockList(),
	};
	if (value === undefined || value === null) return rules;
	if (!Array.isArray(value) || value.length > MAX_HOST_PATTERNS) {
		fail(`.patterns.hosts must be an array of at most ${MAX_HOST_PATTERNS} { label, host | cidr } entries`);
	}
	value.forEach((entry, i) => {
		if (
			!isPlainObject(entry) ||
			Object.keys(entry).some((key) => !HOST_FIELDS.includes(key)) ||
			(entry.host === undefined) === (entry.cidr === undefined)
		) {
			fail(`.patterns.hosts[${i}] must be { label, host } or { label, cidr }`);
		}
		const { label, host, cidr } = entry;
		if (typeof label !== 'string' || !HOST_LABEL.test(label)) {
			fail(`.patterns.hosts[${i}].label must be 1-64 characters of A-Z, a-z, 0-9, _, . or -`);
		}
		if (host !== undefined) {
			const name = typeof host === 'string' ? host.toLowerCase() : '';
			const wildcard = name.startsWith('*.');
			if (!isHostName(wildcard ? name.slice(2) : name)) {
				fail(`.patterns.hosts[${i}].host must be a host name, optionally starting with "*."`);
			}
			if (wildcard) addLabel(rules.suffixes, name.slice(1), label);
			else addLabel(rules.exact, name, label);
			return;
		}
		const [address, prefixText, extra] = typeof cidr === 'string' ? cidr.split('/') : [];
		const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : undefined;
		const prefix = prefixText === undefined ? (family === 'ipv4' ? 32 : 128) : Number(prefixText);
		if (
			!family ||
			extra !== undefined ||
			prefixText === '' ||
			!Number.isInteger(prefix) ||
			prefix < 0 ||
			prefix > (family === 'ipv4' ? 32 : 128)
		) {
			fail(`.patterns.hosts[${i}].cidr must be an IPv4 or IPv6 address or CIDR range`);
		}
		const list = new BlockList();
		list.addSubnet(address, prefix, family);
		rules.anyRange.addSubnet(address, prefix, family);
		rules.ranges.push({ label, list });
	});
	return rules;
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

/**
 * The text the check reads: every author-written field, and every id the memory shows a reader (its own, the ids it
 * supersedes, evidence refs): a chosen id can name a customer, and a URL names its host.
 */
export function checkedText(fields: {
	id: string;
	title?: string | null;
	content?: string | null;
	tags?: readonly string[] | null;
	evidence?: ReadonlyArray<{ ref: string; note?: string | null }> | null;
	supersedes?: readonly string[] | null;
}): string {
	return [
		fields.id,
		fields.title ?? '',
		fields.content ?? '',
		...(fields.tags ?? []),
		...(fields.evidence ?? []).flatMap((item) => [item.ref, item.note ?? '']),
		...(fields.supersedes ?? []),
	].join('\n');
}

const EDGE = new Set(['.', '-', '_']);

function trimEdges(word: string): [trimmed: string, leadingDot: boolean] {
	let start = 0;
	let end = word.length;
	while (start < end && EDGE.has(word[start])) start++;
	while (end > start && EDGE.has(word[end - 1])) end--;
	return [word.slice(start, end), word.slice(0, start).includes('.')];
}

// Prose puts a colon after an address (`2001:db8::1: refused`); `::` at either end is part of the address.
function asIPv6(word: string): string | undefined {
	if (isIPv6(word)) return word;
	const unwrapped = word.replace(/^:(?!:)/, '').replace(/(?<!:):$/, '');
	return unwrapped !== word && isIPv6(unwrapped) ? unwrapped : undefined;
}

function matchHosts(text: string, rules: HostRules, labels: Set<string>): void {
	const add = (found: readonly string[] | undefined) => found?.forEach((label) => labels.add(label));
	const matchAddress = (address: string, family: 'ipv4' | 'ipv6') => {
		if (rules.ranges.length === 0 || !rules.anyRange.check(address, family)) return;
		for (const range of rules.ranges) if (range.list.check(address, family)) labels.add(range.label);
	};
	for (const raw of text.toLowerCase().split(/[^a-z0-9._:-]+/)) {
		const [word] = trimEdges(raw);
		const colon = word.includes(':');
		if (!colon && !word.includes('.')) continue;
		const ipv6 = colon ? asIPv6(word) : undefined;
		if (ipv6) {
			matchAddress(ipv6, 'ipv6');
			continue;
		}
		// A port or a scheme rides on a host after a colon.
		for (const part of colon ? raw.split(':') : [raw]) {
			const [candidate, leadingDot] = trimEdges(part);
			if (isIPv4(candidate)) {
				matchAddress(candidate, 'ipv4');
				continue;
			}
			if (candidate.length > MAX_HOST_NAME_CHARS || !candidate.includes('.')) continue;
			add(rules.exact.get(candidate));
			// `<db>.example.com` or `*.example.com` reaches here as `.example.com`: a name under the domain.
			if (leadingDot) add(rules.suffixes.get(`.${candidate}`));
			for (let dot = candidate.indexOf('.', 1); dot !== -1; dot = candidate.indexOf('.', dot + 1)) {
				add(rules.suffixes.get(candidate.slice(dot)));
			}
		}
	}
}

export function matchCustomerContent(text: string, matcher: CustomerMatcher): string[] {
	const labels = new Set<string>();
	if (matcher.names.size > 0) {
		const words = tokens(text);
		const reached = new Set<NameNode>();
		for (let i = 0; i < words.length; i++) {
			let node = matcher.names.get(words[i]);
			for (let j = i + 1; node; j++) {
				if (node.labels && !reached.has(node)) {
					reached.add(node);
					node.labels.forEach((label) => labels.add(label));
				}
				node = j < words.length ? node.next?.get(words[j]) : undefined;
			}
		}
	}
	const { exact, suffixes, ranges } = matcher.hosts;
	if (exact.size > 0 || suffixes.size > 0 || ranges.length > 0) matchHosts(text, matcher.hosts, labels);
	return [...labels].sort();
}
