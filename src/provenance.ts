import { memoryTable, type MemoryView, STATUS_ACTIVE } from './lifecycle.ts';
import { anyOf, canRead, type Principal } from './scopes.ts';

export type ReviewCause = 'superseded' | 'withdrawn';

interface ReviewFlag {
	since: string;
	cause: ReviewCause;
	sourceId: string;
	replacementId?: string;
}

export const CLEARED_REVIEW = Object.freeze({ needsReview: null, needsReviewSince: null });

export async function activeDependentIds(Memory: any, sourceIds: Iterable<string>, context: object): Promise<string[]> {
	const ids = new Set<string>();
	for (const sourceId of new Set(sourceIds)) {
		for await (const row of Memory.search(
			{
				conditions: [
					{ attribute: 'evidenceMemoryIds', comparator: 'equals', value: sourceId },
					{ attribute: 'status', comparator: 'equals', value: STATUS_ACTIVE },
				],
				select: ['id'],
			},
			context,
		)) {
			ids.add(row.id);
		}
	}
	return [...ids];
}

/**
 * Flags each of `citerIds` that is active, still cites `source.id` and does not supersede it. The caller found
 * and locked the citers before its first write, and adds any the index cannot show yet (rows written in the
 * same transaction). One hop: nothing here flags the citers of a flagged memory. Returns the ids it changed.
 */
export async function flagDependents(
	Memory: any,
	source: { id: string; replacementId?: string },
	cause: ReviewCause,
	citerIds: Iterable<string>,
	context: object,
	now: Date,
): Promise<string[]> {
	const flag: ReviewFlag = {
		since: now.toISOString(),
		cause,
		sourceId: source.id,
		...(source.replacementId ? { replacementId: source.replacementId } : {}),
	};
	const flagged: string[] = [];
	for (const dependentId of new Set(citerIds)) {
		const dependent = await Memory.get(dependentId, context);
		if (
			dependent?.status !== STATUS_ACTIVE ||
			!(dependent.evidenceMemoryIds ?? []).includes(source.id) ||
			// A memory that supersedes the source replaced it rather than relying on it.
			(dependent.supersedes ?? []).includes(source.id) ||
			dependent.needsReview
		) {
			continue;
		}
		await Memory.patch(
			dependentId,
			{ needsReview: flag, needsReviewSince: now, revision: dependent.revision + 1 },
			context,
		);
		flagged.push(dependentId);
	}
	return flagged;
}

/**
 * A flag names its source and replacement, so it is shown only to a reader who
 * can read the source through its labels or owns it (withdrawal ignored: that reader could read it before), and
 * names the replacement only when the reader can read it now. Sinks keep the unredacted views. `access` caches
 * the looked-up rows across calls for one request.
 */
export async function forReader<T extends MemoryView>(
	views: readonly T[],
	principal: Principal,
	context?: object,
	access = new Map<string, any>(),
): Promise<T[]> {
	if (principal.superUser || !views.some((view) => view.needsReview)) return [...views];
	const missing = new Set<string>();
	for (const view of views) {
		const flag = view.needsReview as ReviewFlag | null;
		if (!flag) continue;
		for (const id of [flag.sourceId, flag.replacementId]) if (id && !access.has(id)) missing.add(id);
	}
	if (missing.size > 0) {
		for (const id of missing) access.set(id, undefined);
		for await (const record of memoryTable().search(
			{
				conditions: [anyOf([...missing].map((id) => ({ attribute: 'id', comparator: 'equals', value: id })))],
				select: ['id', 'ownerId', 'scopes', 'status'],
			},
			context,
		)) {
			access.set(record.id, record);
		}
	}
	return views.map((view) => {
		const flag = view.needsReview as ReviewFlag | null;
		if (!flag) return view;
		const source = access.get(flag.sourceId);
		if (!source || !canRead({ ownerId: source.ownerId, scopes: source.scopes }, principal)) {
			return { ...view, needsReview: null };
		}
		if (!flag.replacementId) return view;
		const replacement = access.get(flag.replacementId);
		if (replacement && canRead(replacement, principal)) return view;
		const { replacementId: _unreadable, ...visible } = flag;
		return { ...view, needsReview: visible };
	});
}
