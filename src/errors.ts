import { logger } from 'harper';

// Only errors created here may reach a caller with their own message. Anything else (a dependency's error
// with a statusCode, a storage failure) can carry memory content or credentials, so the resource turns it
// into a generic 500.
const callerSafeErrors = new WeakSet<object>();

export interface MemoryError extends Error {
	statusCode: number;
	code: string;
	index?: number;
}

export function memoryError(message: string, statusCode: number, code: string, index?: number): MemoryError {
	const error = new Error(message) as MemoryError;
	error.statusCode = statusCode;
	error.code = code;
	if (index !== undefined) error.index = index;
	callerSafeErrors.add(error);
	return error;
}

export function badRequest(message: string, code: string): MemoryError {
	return memoryError(message, 400, code);
}

export function notFound(): MemoryError {
	return memoryError('Memory not found', 404, 'memory_not_found');
}

export function isCallerSafe(error: unknown): error is MemoryError {
	return typeof error === 'object' && error !== null && callerSafeErrors.has(error);
}

// Harper's retryable failures: 503 (an index rebuilding or lagging, a database closing), 423 (a record lock not
// granted in time), the 409 a lock lease that lapsed before commit raises, and transient embedding backend
// failures (429, 5xx, timeout, connection failure), whether wrapped by Harper's embedHook or raised by the
// plugin's own embedding before a write. Any other 409 (a sink inserting a row that exists) is a defect, not a
// reason to retry.
function isRetryable(error: any): boolean {
	const status = error?.statusCode;
	const message = String(error?.message ?? '');
	if (status === 503 || status === 423 || (status === 409 && message.startsWith('Record lock'))) return true;
	const upstream = error?.upstreamStatus ?? error?.cause?.upstreamStatus ?? error?.cause?.status;
	if (upstream === 429 || (typeof upstream === 'number' && upstream >= 500 && upstream <= 599)) return true;
	if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
	if (error?.name === 'TypeError' && message === 'fetch failed') return true;
	return /^Failed to compute embedding for attribute "embedding"(?: \[(?:AbortError|TimeoutError|TypeError)\]|.*\(backend HTTP (?:429|5\d\d)\))/.test(
		message,
	);
}

const RETRYABLE_WARN_INTERVAL_MS = 60_000;
let lastRetryableWarning = 0;

export function normalizeError(error: unknown, route: string): MemoryError {
	if (isCallerSafe(error)) return error;
	// The fixed message keeps Harper's text, which is not vetted for callers, out of the response; the log keeps
	// a persistent condition diagnosable without logging every request.
	if (isRetryable(error)) {
		const now = Date.now();
		if (now - lastRetryableWarning >= RETRYABLE_WARN_INTERVAL_MS) {
			lastRetryableWarning = now;
			logger.warn?.(`[agent-memory] ${route} answered 503 for a retryable failure`, error);
		}
		return memoryError('Temporarily unavailable; retry shortly', 503, 'unavailable');
	}
	logger.error?.(`[agent-memory] ${route} failed`, error);
	return memoryError('Internal error', 500, 'internal_error');
}
