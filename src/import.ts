import { badRequest, isCallerSafe, memoryError } from './errors.ts';
import {
	boundedText,
	compareNewest,
	deriveEvidenceMemoryIds,
	embedContents,
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
	VectorNeeded,
	WITHDRAW_REASON_MAX_CHARS,
	withLockPlan,
} from './lifecycle.ts';
import { checkedText, matchCustomerContent } from './patterns.ts';
import { activeDependentIds, CLEARED_REVIEW, flagDependents, reviewFlagFor } from './provenance.ts';
import { contentFlagFields, decideContentFlag } from './quarantine.ts';
import { isScopeLabel, MAX_SCOPES_PER_MEMORY, requirePrincipalId, type Principal } from './scopes.ts';
import { getSettings } from './settings.ts';
import { hasSinks, notifySinks } from './sinks.ts';

const IMPORT_MAX_ROWS = 100;
// Embedding providers cap the tokens in one request, so a batch's rows are embedded in calls of at most this size.
const IMPORT_EMBED_CHARS = 100_000;
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
	ensureEmbedder(Memory);
	// Patterns only: a batch would otherwise start a model call per row.
	const check = { ...settings.customerContentCheck, model: undefined };
	const labelsFor = (text: string) => matchCustomerContent(text, check.matcher);

	const targetIds = new Set<string>(rows.flatMap((row: { supersedes: string[] }) => row.supersedes));
	// A stored row this batch supersedes flags its citers, and citing serializes with that, as on PUT.
	const citedIds = rows.flatMap((row: { evidenceMemoryIds: string[] }) => row.evidenceMemoryIds);
	const plannedDependents = await activeDependentIds(Memory, targetIds, requestContext);
	// Rows are embedded before the transaction, so the batch holds its locks only while it writes.
	const vectors = new Map<string, number[]>();
	const embed = async (ids: Iterable<string>) => {
		const wanted = new Set(ids);
		const missing = rows.filter((row: { id: string }) => wanted.has(row.id) && !vectors.has(row.id));
		const flush = async (batch: Array<{ id: string; content: string }>) => {
			const embedded = await embedContents(
				batch.map((row) => row.content),
				settings.embeddingModel,
			);
			batch.forEach((row, index) => vectors.set(row.id, embedded[index]));
		};
		let batch: Array<{ id: string; content: string }> = [];
		let chars = 0;
		for (const row of missing) {
			if (batch.length > 0 && chars + row.content.length > IMPORT_EMBED_CHARS) {
				await flush(batch);
				batch = [];
				chars = 0;
			}
			batch.push(row);
			chars += row.content.length;
		}
		if (batch.length > 0) await flush(batch);
	};
	const stored = await Promise.all(rows.map((row: { id: string }) => Memory.get(row.id, requestContext)));
	await embed(rows.filter((_row: unknown, index: number) => !stored[index]).map((row: { id: string }) => row.id));

	const write = () =>
		withLockPlan(
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
				const unembedded = created.filter((row) => !vectors.has(row.id)).map((row) => row.id);
				if (unembedded.length > 0) throw new VectorNeeded(unembedded);
				const liveCreated = created.filter((row) => row.status !== STATUS_WITHDRAWN);
				const createdIds = new Set(created.map((row) => row.id));
				const storedTargetIds = [...new Set(liveCreated.flatMap((row) => row.supersedes))].filter(
					(targetId) => !createdIds.has(targetId),
				);
				const citers = new Map<string, string[]>();
				for (const targetId of storedTargetIds) citers.set(targetId, await activeDependentIds(Memory, [targetId], txn));
				locks.require([...citers.values()].flat());
				const graphState = async (targetId: string) => {
					let newest = await newestSuperseder(Memory, targetId, txn);
					for (const row of liveCreated) {
						if (row.supersedes.includes(targetId) && (!newest || compareNewest(row, newest) > 0)) newest = row;
					}
					return newest
						? { status: STATUS_SUPERSEDED, supersededBy: newest.id }
						: { status: STATUS_ACTIVE, supersededBy: null };
				};

				// Rows stored earlier that this batch supersedes (an import that arrived predecessor-first).
				const changed: string[] = [];
				const transitions: Array<{ id: string; replacementId: string }> = [];
				for (const targetId of storedTargetIds) {
					const target = await Memory.get(targetId, txn);
					if (!target || target.status === STATUS_WITHDRAWN) continue;
					const next = await graphState(targetId);
					if (next.status === target.status && next.supersededBy === target.supersededBy) continue;
					await Memory.patch(targetId, { ...next, lastEventKind: 'superseded', revision: target.revision + 1 }, txn);
					changed.push(targetId);
					if (target.status === STATUS_ACTIVE) transitions.push({ id: targetId, replacementId: next.supersededBy! });
				}

				for (const row of created) {
					const state =
						row.status === STATUS_WITHDRAWN
							? { status: row.status, supersededBy: row.supersededBy }
							: await graphState(row.id);
					const { flag: contentFlag } = decideContentFlag(
						check,
						undefined,
						row.scopes,
						checkedText(row),
						labelsFor,
						now,
					);
					let reviewPatch = CLEARED_REVIEW as { needsReview: unknown; needsReviewSince: Date | null };
					for (const source of transitions) {
						const flag = reviewFlagFor({ ...row, ...state }, source, 'superseded', now);
						if (flag) {
							reviewPatch = flag;
							break;
						}
					}
					await Memory.put(
						{
							...row,
							...state,
							embedding: vectors.get(row.id),
							revision: 1,
							lastEventKind: 'created',
							autoSupersedes: [],
							...reviewPatch,
							confirmed: null,
							...contentFlagFields(contentFlag),
							scopeConfirmed: null,
							author: { principalId: row.ownerId, source: 'import', authoredAt: row.createdAt.toISOString() },
							lastEditor: null,
							embeddingModel: settings.embeddingModel,
						},
						txn,
					);
				}

				// After every target is patched, so a citer this batch also supersedes is no longer active to flag.
				for (const source of transitions) {
					changed.push(...(await flagDependents(Memory, source, 'superseded', citers.get(source.id)!, txn, now)));
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
	try {
		return await write();
	} catch (error) {
		// A row deleted after the pre-read (outside the plugin) is created here without a prepared vector.
		if (!(error instanceof VectorNeeded)) throw error;
		await embed(error.ids);
		return write();
	}
}
