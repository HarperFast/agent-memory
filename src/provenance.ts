import { type LockPlan, memoryTable, type MemoryView, STATUS_ACTIVE } from './lifecycle.ts';
import { canRead, type Principal } from './scopes.ts';

export type ReviewCause = 'superseded' | 'withdrawn';

export interface ReviewFlag {
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
 * Flags each active memory citing `source.id` because the source just became `cause`. One hop: nothing here
 * flags the citers of a flagged memory. `extraIds` adds citers the index cannot show yet (rows created in the
 * same transaction). Returns the ids it changed; the caller hands them to sinks after every lock is confirmed.
 */
export async function flagDependents(
	Memory: any,
	source: { id: string; replacementId?: string },
	cause: ReviewCause,
	locks: LockPlan,
	context: object,
	now: Date,
	extraIds: readonly string[] = [],
): Promise<string[]> {
	const dependentIds = [...new Set([...(await activeDependentIds(Memory, [source.id], context)), ...extraIds])];
	locks.require(dependentIds);
	const flag: ReviewFlag = {
		since: now.toISOString(),
		cause,
		sourceId: source.id,
		...(source.replacementId ? { replacementId: source.replacementId } : {}),
	};
	const flagged: string[] = [];
	for (const dependentId of dependentIds) {
		const dependent = await Memory.get(dependentId, context);
		if (
			dependent?.status !== STATUS_ACTIVE ||
			!(dependent.evidenceMemoryIds ?? []).includes(source.id) ||
			// A memory that supersedes the source replaced it rather than relying on it.
			(dependent.supersedes ?? []).includes(source.id) ||
			// The first cause stands until the owner revises or confirms.
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
 * The caller's views of `views`. A flag names its source and replacement, so it is shown only to a reader who
 * can read the source through its labels or owns it (withdrawal ignored: that reader could read it before), and
 * names the replacement only when the reader can read it now. Sinks keep the unredacted views.
 */
export async function forReader<T extends MemoryView>(
	views: readonly T[],
	principal: Principal,
	context?: object,
): Promise<T[]> {
	if (principal.superUser || !views.some((view) => view.needsReview)) return [...views];
	const Memory = memoryTable();
	const loaded = new Map<string, Promise<any>>();
	const load = (id: string) => {
		let record = loaded.get(id);
		if (!record) loaded.set(id, (record = Memory.get(id, context)));
		return record;
	};
	return Promise.all(
		views.map(async (view) => {
			const flag = view.needsReview as ReviewFlag | null;
			if (!flag) return view;
			const source = await load(flag.sourceId);
			if (!source || !canRead({ ownerId: source.ownerId, scopes: source.scopes }, principal)) {
				return { ...view, needsReview: null };
			}
			if (!flag.replacementId) return view;
			const replacement = await load(flag.replacementId);
			if (replacement && canRead(replacement, principal)) return view;
			const { replacementId: _unreadable, ...visible } = flag;
			return { ...view, needsReview: visible };
		}),
	);
}
