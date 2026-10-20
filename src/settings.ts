import { CONTENT_CHECK_OFF, parseContentCheck, type ContentCheckSettings, type SecretsSource } from './patterns.ts';

export type SupersessionMode = 'off' | 'suggest' | 'auto';

export interface SupersessionSettings {
	readonly mode: SupersessionMode;
	readonly similarity: number;
	readonly judge?: string;
}

export interface Settings {
	readonly urlPath: string;
	readonly embeddingModel: string;
	readonly titleChars: number;
	readonly contentChars: number;
	readonly supersession: SupersessionSettings;
	readonly customerContentCheck: ContentCheckSettings;
	readonly mcp: boolean;
}

export const DEFAULT_EMBEDDING_MODEL = 'default';
const MAX_CONTENT_CHARS = 100_000;
const MAX_TITLE_CHARS = 1_000;
const DEFAULT_SUPERSESSION: SupersessionSettings = Object.freeze({ mode: 'suggest', similarity: 0.82 });

let current: Settings = Object.freeze({
	urlPath: 'Memory',
	embeddingModel: DEFAULT_EMBEDDING_MODEL,
	titleChars: 200,
	contentChars: 20_000,
	supersession: DEFAULT_SUPERSESSION,
	customerContentCheck: CONTENT_CHECK_OFF,
	mcp: false,
});

export function getSettings(): Settings {
	return current;
}

function boundedInteger(value: unknown, fallback: number, max: number, name: string): number {
	if (value === undefined || value === null) return fallback;
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
		throw new Error(`@harperfast/agent-memory: ${name} must be an integer between 1 and ${max}`);
	}
	return value as number;
}

function parseSupersession(options: unknown): SupersessionSettings {
	if (options === undefined || options === null) return DEFAULT_SUPERSESSION;
	if (typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('@harperfast/agent-memory: supersession must be an object');
	}
	const { mode = 'suggest', similarity = 0.82, judge } = options as Record<string, unknown>;
	if (mode !== 'off' && mode !== 'suggest' && mode !== 'auto') {
		throw new Error('@harperfast/agent-memory: supersession.mode must be off, suggest or auto');
	}
	if (typeof similarity !== 'number' || !(similarity > 0 && similarity <= 1)) {
		throw new Error('@harperfast/agent-memory: supersession.similarity must be a number in (0, 1]');
	}
	if (judge !== undefined && judge !== null && (typeof judge !== 'string' || !judge)) {
		throw new Error('@harperfast/agent-memory: supersession.judge must be a non-empty model name');
	}
	if (mode === 'auto' && !judge) {
		throw new Error('@harperfast/agent-memory: supersession.mode auto requires supersession.judge');
	}
	return Object.freeze({ mode, similarity, ...(judge ? { judge: judge as string } : {}) });
}

export function parseSettings(options: Record<string, any>, secrets: SecretsSource = () => undefined): Settings {
	const urlPath = String(options.urlPath ?? 'Memory').replace(/^\/+|\/+$/g, '');
	if (!urlPath) throw new Error('@harperfast/agent-memory: urlPath must not be empty');
	const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
	if (typeof embeddingModel !== 'string' || !embeddingModel) {
		throw new Error('@harperfast/agent-memory: embeddingModel must be a non-empty string');
	}
	const mcp = options.mcp ?? false;
	if (typeof mcp !== 'boolean') {
		throw new Error('@harperfast/agent-memory: mcp must be a boolean');
	}
	return Object.freeze({
		urlPath,
		embeddingModel,
		titleChars: boundedInteger(options.limits?.titleChars, 200, MAX_TITLE_CHARS, 'limits.titleChars'),
		contentChars: boundedInteger(options.limits?.contentChars, 20_000, MAX_CONTENT_CHARS, 'limits.contentChars'),
		supersession: parseSupersession(options.supersession),
		customerContentCheck: parseContentCheck(options.customerContentCheck, secrets),
		mcp,
	});
}

export function applySettings(settings: Settings): void {
	current = settings;
}
