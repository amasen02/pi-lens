/**
 * Bounded worker pool — the repo's one shared `mapWithConcurrency`.
 *
 * Lived in `dependency-checker.ts` (its first caller) and was exported from
 * there for `dispatch/runners/biome-check.ts`. #2504 added a third caller,
 * `runtime-turn.ts`'s bounded test-runner batch — and runtime-turn must not
 * drag an ANALYZER client into its eager import graph for a 15-line helper
 * (that is exactly the eager-bootstrap cost #2467 removed). So the value moved
 * to this zero-dependency leaf and `dependency-checker.ts` re-exports it: every
 * existing importer keeps its specifier, and a consumer that only needs the
 * pool no longer loads madge.
 *
 * Same shape as `ledger-bounds.ts` (#2426) for the degradation ledger's bound.
 *
 * NOT consolidated here: `lsp/client.ts` keeps its own file-local copy on
 * purpose (see its comment) — that is a documented decision, not drift.
 */

/**
 * Run `mapper` over `items` with at most `concurrency` in flight at once.
 */
export async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			await mapper(items[index]);
		}
	};
	const workers = Array.from({ length: workerCount }, () => worker());
	await Promise.all(workers);
}
