export interface Settings {
	readonly urlPath: string;
	readonly embeddingModel: string;
	readonly titleChars: number;
	readonly contentChars: number;
}

export const DEFAULT_EMBEDDING_MODEL = 'default';
const MAX_CONTENT_CHARS = 100_000;
const MAX_TITLE_CHARS = 1_000;

let current: Settings = Object.freeze({
	urlPath: 'Memory',
	embeddingModel: DEFAULT_EMBEDDING_MODEL,
	titleChars: 200,
	contentChars: 20_000,
});

/** Each request reads this once, so a reload mid-request cannot mix two configurations. */
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

/** Validates the plugin's options; throws without changing the current settings. */
export function parseSettings(options: Record<string, any>): Settings {
	const urlPath = String(options.urlPath ?? 'Memory').replace(/^\/+|\/+$/g, '');
	if (!urlPath) throw new Error('@harperfast/agent-memory: urlPath must not be empty');
	const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
	if (typeof embeddingModel !== 'string' || !embeddingModel) {
		throw new Error('@harperfast/agent-memory: embeddingModel must be a non-empty string');
	}
	return Object.freeze({
		urlPath,
		embeddingModel,
		titleChars: boundedInteger(options.limits?.titleChars, 200, MAX_TITLE_CHARS, 'limits.titleChars'),
		contentChars: boundedInteger(options.limits?.contentChars, 20_000, MAX_CONTENT_CHARS, 'limits.contentChars'),
	});
}

export function applySettings(settings: Settings): void {
	current = settings;
}
