import { badRequest, isCallerSafe, memoryError } from './errors.ts';
import {
	boundedText,
	compareNewest,
	deriveEvidenceMemoryIds,
	ensureEmbedder,
	isMemoryId,
	LONG_LOCK_LEASE_MS,
	memoryTable,
	newestSuperseder,
	normalizeEvidence,
	normalizeIds,
	normalizeTags,
	optionalDate,
	rejectUnknownFields,
	sameEditableFields,
	sameStringArray,
	STATUS_ACTIVE,
	STATUS_SUPERSEDED,
	STATUS_WITHDRAWN,
	toMemoryView,
	WITHDRAW_REASON_MAX_CHARS,
	withLockPlan,
} from './lifecycle.ts';
import { activeDependentIds, CLEARED_REVIEW, flagDependents } from './provenance.ts';
import { isScopeLabel, MAX_SCOPES_PER_MEMORY, requirePrincipalId, type Principal } from './scopes.ts';
import { getSettings } from './settings.ts';
import { hasSinks, notifySinks } from './sinks.ts';

const IMPORT_MAX_ROWS = 100;
const IMPORT_SUPERSEDES_MAX_ITEMS = 100;
const ROW_FIELDS = [
	'id',
	'ownerId',
	'title',
	'content',
	'tags',
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
		if (!isMemoryId(row.id)) {
			throw badRequest('id must be 16-64 URL-safe characters (^[A-Za-z0-9_-]{16,64}$)', 'invalid_id');
		}
		const id = row.id;
		if (typeof row.ownerId !== 'string' || !row.ownerId) throw badRequest('ownerId is required', 'ownerId_required');
		const ownerId = requirePrincipalId(row.ownerId);
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
		const evidence = normalizeEvidence(row.evidence);
		return {
			id,
			ownerId,
			title: boundedText(row.title, 'title', settings.titleChars, false) ?? null,
			content: boundedText(row.content, 'content', settings.contentChars, true)!,
			tags: normalizeTags(row.tags),
			evidence,
			evidenceMemoryIds: deriveEvidenceMemoryIds(evidence),
			scopes,
			status,
			supersedes,
			supersededBy,
			createdAt: optionalDate(row.createdAt, 'createdAt'),
			validUntil: optionalDate(row.validUntil, 'validUntil') ?? null,
			withdrawnAt: withdrawnAt ?? null,
			withdrawnReason: withdrawnReason ?? null,
		};
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

	const targetIds = new Set<string>(rows.flatMap((row: { supersedes: string[] }) => row.supersedes));
	// A stored row this batch supersedes flags its citers, and citing serializes with that, as on PUT.
	const citedIds = rows.flatMap((row: { evidenceMemoryIds: string[] }) => row.evidenceMemoryIds);
	const plannedDependents = await activeDependentIds(Memory, targetIds, requestContext);

	return withLockPlan(
		requestContext,
		[...rows.map((row: { id: string }) => row.id), ...targetIds, ...citedIds, ...plannedDependents],
		async (txn, locks) => {
			const results: Array<{ id: string; result: ImportResult }> = [];
			const created = [];
			const now = new Date();
			for (const row of rows) {
				const existing = await Memory.get(row.id, txn);
				if (existing) {
					const same =
						existing.ownerId === row.ownerId &&
						sameEditableFields(existing, row) &&
						sameStringArray(existing.supersedes ?? [], row.supersedes) &&
						(row.status !== STATUS_WITHDRAWN ||
							(existing.status === STATUS_WITHDRAWN && (existing.withdrawnReason ?? null) === row.withdrawnReason));
					results.push({ id: row.id, result: same ? 'unchanged' : 'conflict' });
				} else {
					created.push({ ...row, createdAt: row.createdAt ?? now });
					results.push({ id: row.id, result: 'created' });
				}
			}
			const liveCreated = created.filter((row) => row.status !== STATUS_WITHDRAWN);
			const graphState = async (targetId: string) => {
				let newest = await newestSuperseder(Memory, targetId, txn);
				for (const row of liveCreated) {
					if (row.supersedes.includes(targetId) && (!newest || compareNewest(row, newest) > 0)) newest = row;
				}
				return newest
					? { status: STATUS_SUPERSEDED, supersededBy: newest.id }
					: { status: STATUS_ACTIVE, supersededBy: null };
			};

			for (const row of created) {
				const state =
					row.status === STATUS_WITHDRAWN
						? { status: row.status, supersededBy: row.supersededBy }
						: await graphState(row.id);
				await Memory.put(
					{
						...row,
						...state,
						revision: 1,
						autoSupersedes: [],
						...CLEARED_REVIEW,
						confirmed: null,
						author: { principalId: row.ownerId, source: 'import', authoredAt: row.createdAt.toISOString() },
						lastEditor: null,
						embeddingModel: settings.embeddingModel,
					},
					txn,
				);
			}

			// Rows stored earlier that this batch supersedes (an import that arrived predecessor-first).
			const createdIds = new Set(created.map((row) => row.id));
			const changed: string[] = [];
			const transitions = [];
			for (const targetId of new Set(liveCreated.flatMap((row) => row.supersedes))) {
				if (createdIds.has(targetId)) continue;
				const target = await Memory.get(targetId, txn);
				if (!target || target.status === STATUS_WITHDRAWN) continue;
				const next = await graphState(targetId);
				if (next.status === target.status && next.supersededBy === target.supersededBy) continue;
				await Memory.patch(targetId, { ...next, revision: target.revision + 1 }, txn);
				changed.push(targetId);
				if (target.status === STATUS_ACTIVE) transitions.push({ id: targetId, replacementId: next.supersededBy! });
			}
			// After every target is patched, so a citer this batch also supersedes is no longer active to flag.
			for (const source of transitions) {
				// The index does not show this batch's rows inside the transaction, so its citers are named here.
				const batchCiters = liveCreated.filter((row) => row.evidenceMemoryIds.includes(source.id)).map((row) => row.id);
				changed.push(...(await flagDependents(Memory, source, 'superseded', locks, txn, now, batchCiters)));
			}

			// Sinks run once every lock is confirmed, so an attempt the lock plan restarts never reaches one.
			if (hasSinks()) {
				for (const row of created) {
					const memory = toMemoryView(await Memory.get(row.id, txn));
					await notifySinks(row.status === STATUS_WITHDRAWN ? 'withdraw' : 'write', memory, txn);
				}
				for (const changedId of new Set(changed)) {
					if (createdIds.has(changedId)) continue;
					await notifySinks('write', toMemoryView(await Memory.get(changedId, txn)), txn);
				}
			}
			return { results };
		},
		LONG_LOCK_LEASE_MS,
	);
}
