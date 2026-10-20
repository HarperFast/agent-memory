import { memoryTable, type MemoryView, STATUS_ACTIVE } from './lifecycle.ts';
import { anyOf, canRead, readsCustomerContent, type Principal } from './scopes.ts';

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

export function reviewFlagFor(
	dependent:
		| {
				status?: string;
				evidenceMemoryIds?: readonly string[];
				supersedes?: readonly string[];
				needsReview?: unknown;
		  }
		| null
		| undefined,
	source: { id: string; replacementId?: string },
	cause: ReviewCause,
	now: Date,
): { needsReview: ReviewFlag; needsReviewSince: Date } | undefined {
	if (
		dependent?.status !== STATUS_ACTIVE ||
		!(dependent.evidenceMemoryIds ?? []).includes(source.id) ||
		// A memory that supersedes the source replaced it rather than relying on it.
		(dependent.supersedes ?? []).includes(source.id) ||
		dependent.needsReview
	) {
		return undefined;
	}
	return {
		needsReview: {
			since: now.toISOString(),
			cause,
			sourceId: source.id,
			...(source.replacementId ? { replacementId: source.replacementId } : {}),
		},
		needsReviewSince: now,
	};
}

/**
 * The caller found and locked `citerIds` before its first write, adding any the index cannot show yet (rows
 * written in the same transaction). One hop: nothing here flags the citers of a flagged memory.
 */
export async function flagDependents(
	Memory: any,
	source: { id: string; replacementId?: string },
	cause: ReviewCause,
	citerIds: Iterable<string>,
	context: object,
	now: Date,
): Promise<string[]> {
	const flagged: string[] = [];
	for (const dependentId of new Set(citerIds)) {
		const dependent = await Memory.get(dependentId, context);
		const reviewPatch = reviewFlagFor(dependent, source, cause, now);
		if (!reviewPatch) continue;
		await Memory.patch(
			dependentId,
			{ ...reviewPatch, lastEventKind: 'flagged', revision: dependent.revision + 1 },
			context,
		);
		flagged.push(dependentId);
	}
	return flagged;
}

// Which customer a flag matched reveals that the name is on the customer list.
function withoutFlagLabels<T extends MemoryView>(view: T): T {
	const flag = view.contentFlag as { labels?: unknown } | null;
	if (!flag?.labels) return view;
	const { labels: _hidden, ...visible } = flag;
	return { ...view, contentFlag: visible };
}

/**
 * A flag names its source and replacement, so it is shown only to a reader who
 * can read the source through its labels or owns it (withdrawal ignored: that reader could read it before), and
 * names the replacement only when the reader can read it now. A content flag's labels are shown only to a reader
 * cleared for customer content. Sinks keep the unredacted views. `access` caches the looked-up rows across calls
 * for one request.
 */
export async function forReader<T extends MemoryView>(
	unredacted: readonly T[],
	principal: Principal,
	context?: object,
	access = new Map<string, Promise<any>>(),
): Promise<T[]> {
	const cleared = readsCustomerContent(principal);
	const views =
		cleared || !unredacted.some((view) => (view.contentFlag as any)?.labels)
			? unredacted
			: unredacted.map(withoutFlagLabels);
	// Only a quarantined replacement can be unreadable to a label reader of what it supersedes.
	const checksReplacement = (view: T) => !cleared && typeof view.supersededBy === 'string';
	if (principal.superUser) return [...views];
	if (!views.some((view) => view.needsReview || checksReplacement(view))) return [...views];
	const missing = new Set<string>();
	for (const view of views) {
		const flag = view.needsReview as ReviewFlag | null;
		for (const id of [flag?.sourceId, flag?.replacementId]) if (id && !access.has(id)) missing.add(id);
	}
	for (const view of views) {
		const id = view.supersededBy as string;
		if (!checksReplacement(view) || access.has(id) || missing.has(id)) continue;
		// A primary-key read: a search costs about 6 ms more on a single GET of a superseded memory.
		const record = Promise.resolve(memoryTable().get(id, context));
		record.catch(() => {});
		access.set(id, record);
	}
	if (missing.size > 0) {
		// Cached as a promise, so a concurrent caller waits for this lookup rather than reading an unfinished one.
		const found = (async () => {
			const records = new Map<string, any>();
			for await (const record of memoryTable().search(
				{
					conditions: [anyOf([...missing].map((id) => ({ attribute: 'id', comparator: 'equals', value: id })))],
					select: ['id', 'ownerId', 'scopes', 'status', 'contentFlag'],
				},
				context,
			)) {
				records.set(record.id, record);
			}
			return records;
		})();
		for (const id of missing) {
			const record = found.then((records) => records.get(id));
			// A failed lookup rejects for whoever awaits it; an entry nobody awaits must not surface as unhandled.
			record.catch(() => {});
			access.set(id, record);
		}
	}
	return Promise.all(
		views.map(async (shown) => {
			let view = shown;
			if (checksReplacement(view)) {
				const replacement = await access.get(view.supersededBy as string);
				// The check reads a memory's chosen id, so a quarantined replacement's id is held back like the memory.
				if (replacement?.contentFlag && !canRead(replacement, principal)) view = { ...view, supersededBy: null };
			}
			const flag = view.needsReview as ReviewFlag | null;
			if (!flag) return view;
			const source = await access.get(flag.sourceId);
			if (
				!source ||
				!canRead({ ownerId: source.ownerId, scopes: source.scopes, contentFlag: source.contentFlag }, principal)
			) {
				return { ...view, needsReview: null };
			}
			if (!flag.replacementId) return view;
			const replacement = await access.get(flag.replacementId);
			if (replacement && canRead(replacement, principal)) return view;
			const { replacementId: _unreadable, ...visible } = flag;
			return { ...view, needsReview: visible };
		}),
	);
}
