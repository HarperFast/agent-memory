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
