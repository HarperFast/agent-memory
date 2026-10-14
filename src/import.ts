// POST /Memory/import (super_user): bulk import with preserved owner, createdAt, status and supersession
// links. Rows are written as given — the client derives status and links from its source and sends
// successors before predecessors — and one request is one transaction.
import { badRequest, isCallerSafe, memoryError } from './errors.ts';
import {
	boundedText,
	ensureEmbedder,
	fingerprint,
	inOwnTransaction,
	IDEMPOTENCY_KEY_MAX_CHARS,
	IMPORT_KEY_PREFIX,
	DURABILITY_MAX_CHARS,
	isMemoryId,
	lockRows,
	memoryIdFor,
	memoryTable,
	normalizeEvidence,
	normalizeIds,
	normalizeTags,
	optionalDate,
	rejectUnknownFields,
	STATUS_ACTIVE,
	STATUS_SUPERSEDED,
	STATUS_WITHDRAWN,
	toMemoryView,
	WITHDRAW_REASON_MAX_CHARS,
} from './lifecycle.ts';
import { isScopeLabel, MAX_SCOPES_PER_MEMORY, requirePrincipalId, type Principal } from './scopes.ts';
import { getSettings } from './settings.ts';
import { notifySinks } from './sinks.ts';

export const IMPORT_MAX_ROWS = 100;
const IMPORT_SUPERSEDES_MAX_ITEMS = 100;
const ROW_FIELDS = [
	'id',
	'idempotencyKey',
	'ownerId',
	'title',
	'content',
	'tags',
	'durability',
	'pinned',
	'evidence',
	'scopes',
	'status',
	'supersedes',
	'supersededBy',
	'createdAt',
	'validUntil',
	'withdrawnAt',
	'withdrawnReason',
];
const STATUSES = [STATUS_ACTIVE, STATUS_SUPERSEDED, STATUS_WITHDRAWN];

export type ImportResult = 'created' | 'unchanged' | 'conflict';

function validateRow(input: unknown, index: number) {
	try {
		const row = rejectUnknownFields(input, ROW_FIELDS, 'import row');
		const settings = getSettings();
		const ownerId = requirePrincipalId(row.ownerId);
		const idempotencyKey = boundedText(row.idempotencyKey, 'idempotencyKey', IDEMPOTENCY_KEY_MAX_CHARS, true)!;
		if (!idempotencyKey.startsWith(IMPORT_KEY_PREFIX)) {
			throw badRequest(`import idempotencyKey must start with "${IMPORT_KEY_PREFIX}"`, 'invalid_idempotencyKey');
		}
		const id = memoryIdFor(ownerId, idempotencyKey);
		if (row.id !== undefined && row.id !== id) {
			throw badRequest('id does not match sha256(memory:<ownerId>:<idempotencyKey>)', 'import_id_mismatch');
		}
		if (!Array.isArray(row.scopes) || row.scopes.length === 0 || !row.scopes.every(isScopeLabel)) {
			throw badRequest('scopes must be a non-empty array of scope labels', 'invalid_scopes');
		}
		const scopes = [...new Set(row.scopes as string[])].sort();
		if (scopes.length > MAX_SCOPES_PER_MEMORY) {
			throw badRequest(`A memory carries at most ${MAX_SCOPES_PER_MEMORY} scope labels`, 'too_many_scopes');
		}
		const status = row.status ?? STATUS_ACTIVE;
		if (!STATUSES.includes(status)) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`, 'invalid_status');
		const supersedes = normalizeIds(row.supersedes, 'supersedes', IMPORT_SUPERSEDES_MAX_ITEMS);
		const supersededBy = row.supersededBy ?? null;
		if (supersededBy !== null && !isMemoryId(supersededBy)) {
			throw badRequest('supersededBy must be a memory id', 'invalid_supersededBy');
		}
		if (supersedes.includes(id) || supersededBy === id)
			throw badRequest('a memory cannot supersede itself', 'self_supersede');
		if ((status === STATUS_SUPERSEDED) !== (supersededBy !== null) && status !== STATUS_WITHDRAWN) {
			throw badRequest('supersededBy is required exactly when status is superseded', 'invalid_supersededBy');
		}
		const withdrawnAt = optionalDate(row.withdrawnAt, 'withdrawnAt');
		const withdrawnReason = boundedText(row.withdrawnReason, 'withdrawnReason', WITHDRAW_REASON_MAX_CHARS, false);
		if ((withdrawnAt || withdrawnReason) && status !== STATUS_WITHDRAWN) {
			throw badRequest('withdrawnAt and withdrawnReason require status withdrawn', 'invalid_status');
		}
		const pinned = row.pinned ?? false;
		if (typeof pinned !== 'boolean') throw badRequest('pinned must be a boolean', 'invalid_pinned');
		const record = {
			id,
			idempotencyKey,
			ownerId,
			title: boundedText(row.title, 'title', settings.titleChars, false) ?? null,
			content: boundedText(row.content, 'content', settings.contentChars, true)!,
			tags: normalizeTags(row.tags),
			durability: boundedText(row.durability, 'durability', DURABILITY_MAX_CHARS, false) ?? null,
			pinned,
			evidence: normalizeEvidence(row.evidence),
			scopes,
			status,
			supersedes,
			supersededBy,
			createdAt: optionalDate(row.createdAt, 'createdAt'),
			validUntil: optionalDate(row.validUntil, 'validUntil') ?? null,
			withdrawnAt: withdrawnAt ?? null,
			withdrawnReason: withdrawnReason ?? null,
		};
		return { ...record, createFingerprint: fingerprint(['import', ...Object.values(record)]) };
	} catch (error) {
		if (isCallerSafe(error)) throw memoryError(error.message, error.statusCode, error.code, index);
		throw error;
	}
}

export async function importMemories(input: unknown, principal: Principal, requestContext: object) {
	if (!principal.superUser) throw memoryError('Import requires super_user', 403, 'import_forbidden');
	const payload = rejectUnknownFields(input, ['rows'], 'import');
	if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
		throw badRequest('rows must be a non-empty array', 'invalid_rows');
	}
	if (payload.rows.length > IMPORT_MAX_ROWS) {
		throw badRequest(`import accepts at most ${IMPORT_MAX_ROWS} rows per request`, 'too_many_rows');
	}
	const rows = payload.rows.map(validateRow);
	const seen = new Set<string>();
	rows.forEach((row: { id: string }, index: number) => {
		if (seen.has(row.id)) throw memoryError('duplicate row in batch', 400, 'duplicate_row', index);
		seen.add(row.id);
	});
	const settings = getSettings();
	const Memory = memoryTable();
	ensureEmbedder(Memory, settings);

	return inOwnTransaction(requestContext, async (txn) => {
		await lockRows(
			Memory,
			rows.map((row: { id: string }) => row.id),
			txn,
		);
		const results: Array<{ id: string; result: ImportResult }> = [];
		for (const row of rows) {
			const existing = await Memory.get(row.id, txn);
			if (existing) {
				results.push({
					id: row.id,
					result: existing.createFingerprint === row.createFingerprint ? 'unchanged' : 'conflict',
				});
				continue;
			}
			const createdAt = row.createdAt ?? new Date();
			await Memory.put(
				{
					...row,
					createdAt,
					revision: 1,
					author: { principalId: row.ownerId, source: 'import', authoredAt: createdAt.toISOString() },
					lastEditor: null,
					embeddingModel: settings.embeddingModel,
				},
				txn,
			);
			const memory = toMemoryView(await Memory.get(row.id, txn));
			await notifySinks(row.status === STATUS_WITHDRAWN ? 'withdraw' : 'write', memory, txn);
			results.push({ id: row.id, result: 'created' });
		}
		return { results };
	});
}
