/**
 * scripts/lib/ci-checks.mjs (#2539 round 2, F2): the ONE required-checks name
 * list and the ONE fail-closed "latest check-run per name" resolver, shared
 * by every consumer that reads GitHub check-runs for this repo's two gating
 * checks -- merge-train-warden.mjs (GraphQL rollup: `startedAt`, UPPERCASE
 * `status`/`conclusion`), merge-train-lane.mjs (via the warden today, moved
 * to import this module directly in this round), and ci-verdict.mjs (REST
 * `commits/<sha>/check-runs`: `started_at`, lowercase `status`/`conclusion`).
 *
 * Before this round, ci-verdict.mjs hand-rolled its own `latestRunNamed`
 * with an `id`-as-tiebreak policy that is NOT fail-closed (a superseded
 * SUCCESS with the higher id could win a tie over an unresolved duplicate),
 * while merge-train-warden.mjs already carried the correct policy. Two
 * required-check name lists and two different tie policies for the same
 * real-world duplicate-check-run shape (a rerun, or the classify-ci-failure
 * auto-rerun, #2103) is the single-source-of-truth defect this module fixes.
 */

export const REQUIRED_CHECKS = ["Unit tests", "Lint & type-check"];

function startedAtOf(run) {
	return run?.startedAt ?? run?.started_at ?? null;
}

// Case-insensitive: GraphQL reports "COMPLETED"/"SUCCESS", REST reports
// "completed"/"success". Comparing case-insensitively here is what lets ONE
// tie policy serve both payload shapes without either caller normalizing
// its check-run records first.
function isConcludedSuccess(run) {
	const status = String(run?.status ?? "").toUpperCase();
	const conclusion = String(run?.conclusion ?? "").toUpperCase();
	return status === "COMPLETED" && conclusion === "SUCCESS";
}

/**
 * Fail-closed tie policy (#2190 incident): when two check-runs share a name
 * and neither `startedAt`/`started_at` orders them (missing, unparsable, or
 * exactly equal), the run that is NOT a concluded success wins. An
 * unorderable tie can only ever withhold a pass, never grant one.
 */
export function preferCheckRun(a, b) {
	const ta = Date.parse(startedAtOf(a) ?? "");
	const tb = Date.parse(startedAtOf(b) ?? "");
	if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb)
		return ta > tb ? a : b;
	if (isConcludedSuccess(a) && !isConcludedSuccess(b)) return b;
	if (isConcludedSuccess(b) && !isConcludedSuccess(a)) return a;
	return a;
}

/**
 * One check-run per NAME, newest wins via `preferCheckRun`. GitHub's own
 * rollup really does carry duplicate names on one head (a PR head listed six
 * names twice; another listed `Unit tests` as both IN_PROGRESS and
 * COMPLETED/SUCCESS at once) and the API documents no ordering guarantee
 * across reruns, so array order/position is never trusted here.
 */
export function resolveLatestByName(checkRuns) {
	const byName = new Map();
	for (const run of checkRuns ?? []) {
		const incumbent = byName.get(run.name);
		byName.set(run.name, incumbent ? preferCheckRun(incumbent, run) : run);
	}
	return byName;
}
