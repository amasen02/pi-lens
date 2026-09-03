#!/usr/bin/env node
/**
 * scripts/ci-verdict.mjs (#2539): ONE REST read of the two required checks'
 * conclusions on an EXACT head SHA, replacing the ad hoc `gh api` filters the
 * fixer/reviewer playbooks were hand-writing and the tail of `gh pr checks`,
 * which hid a failed Unit tests behind a passing Lint (#2527 review round 2
 * merge-blocked on exactly that). Sibling to scripts/check-pr-body.mjs: a
 * pure verdict function over the check-runs JSON, exported for tests, and a
 * thin `gh` CLI shell around it -- no GITHUB_TOKEN/GITHUB_API_URL plumbing,
 * just `gh` on PATH (the issue's acceptance criterion).
 *
 *   node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>]
 *
 * Exit codes:
 *   0 -- both required checks concluded "success"
 *   1 -- either required check completed with a non-"success" conclusion
 *   2 -- either required check is ABSENT from check-runs (DIRTY PR: a
 *        merge-conflicted PR can't build its merge-ref, so the real gates are
 *        skipped, not failed -- AGENTS.md recurring-defect shape 11)
 *   3 -- either required check is still queued/in_progress (pending)
 *
 * `--wait <seconds>` polls at a fixed, non-configurable >=30s interval, for
 * the orchestrator only -- never in a tight loop. The requested budget is
 * clamped to a hard cap so a large ask can't itself become the next
 * 5000/hr-API-budget incident (12 agents polling `gh pr checks --watch` in
 * one day, #2539's own motivating history) plus the fabricated-CI-quote and
 * hidden-Unit-tests-failure incidents this script exists to replace.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REQUIRED_CHECKS = ["Unit tests", "Lint & type-check"];

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_DIRTY = 2;
export const EXIT_PENDING = 3;

export const POLL_INTERVAL_SECONDS = 30;
export const HARD_CAP_SECONDS = 20 * 60;

/**
 * True for a bare PR number ("2539"); false for anything sha-shaped
 * (abbreviated or full hex). `gh pr view <n>` and this repo's own SHAs never
 * collide with an all-decimal PR number in practice, so the numeric shape
 * alone is enough to disambiguate.
 */
export function isPrNumber(arg) {
	return /^\d+$/.test(String(arg ?? "").trim());
}

/**
 * Pick the most recently STARTED run for one check name. A rerun (or the
 * classify-ci-failure.mjs auto-rerun, #2103) can leave more than one
 * check-run entry with the same name in one commit's check-runs response;
 * the API does not document array order across reruns, so this compares
 * `started_at` explicitly (id as the tiebreak) instead of trusting position
 * -- an older entry sorted after a newer one would silently report a stale
 * conclusion.
 */
function latestRunNamed(checkRuns, name) {
	const matches = checkRuns.filter((run) => run?.name === name);
	if (matches.length === 0) return null;
	return matches.reduce((latest, run) => {
		if (!latest) return run;
		const latestStarted = Date.parse(latest.started_at ?? "") || 0;
		const runStarted = Date.parse(run.started_at ?? "") || 0;
		if (runStarted !== latestStarted)
			return runStarted > latestStarted ? run : latest;
		return (run.id ?? 0) > (latest.id ?? 0) ? run : latest;
	}, null);
}

/**
 * Pure verdict over one commit's check-runs payload -- the literal
 * `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` response shape,
 * `{ check_runs: [...] }`. No I/O, no `gh`, no fetch; exported so the four
 * exit codes are unit-testable against a mocked payload.
 *
 * Precedence when a payload matches more than one condition (mirrors the
 * order the issue lists them in): DIRTY (absent) beats FAILURE beats
 * PENDING beats SUCCESS -- an absent required check is the most severe,
 * distinct signal (the PR can't even build its merge-ref), so it wins even
 * when the other required check independently failed or is still running.
 */
export function computeVerdict(
	checkRunsPayload,
	requiredChecks = REQUIRED_CHECKS,
) {
	const checkRuns = Array.isArray(checkRunsPayload?.check_runs)
		? checkRunsPayload.check_runs
		: [];
	const rows = requiredChecks.map((name) => {
		const run = latestRunNamed(checkRuns, name);
		if (!run) {
			return {
				name,
				present: false,
				status: null,
				conclusion: null,
				url: null,
			};
		}
		return {
			name,
			present: true,
			status: run.status ?? null,
			conclusion: run.conclusion ?? null,
			url: run.html_url ?? run.details_url ?? null,
		};
	});

	let exitCode;
	let reason;
	if (rows.some((row) => !row.present)) {
		exitCode = EXIT_DIRTY;
		reason =
			"one or more required checks are absent (DIRTY PR: merge-conflicted, real gates skipped not failed -- AGENTS.md shape 11)";
	} else if (
		rows.some(
			(row) => row.status === "completed" && row.conclusion !== "success",
		)
	) {
		exitCode = EXIT_FAILURE;
		reason =
			"one or more required checks completed with a non-success conclusion";
	} else if (rows.some((row) => row.status !== "completed")) {
		exitCode = EXIT_PENDING;
		reason = "one or more required checks are still queued or in progress";
	} else {
		exitCode = EXIT_SUCCESS;
		reason = "both required checks concluded success";
	}
	return { exitCode, rows, reason };
}

/** Fixed-column table: CHECK / STATUS / CONCLUSION / URL. Exported for tests
 * so the rendering itself is pinned, not just eyeballed from CLI output. */
export function formatVerdictTable(rows) {
	const header = ["CHECK", "STATUS", "CONCLUSION", "URL"];
	const data = rows.map((row) => [
		row.name,
		row.present ? (row.status ?? "unknown") : "absent",
		row.present ? (row.conclusion ?? "-") : "-",
		row.present ? (row.url ?? "-") : "-",
	]);
	const widths = header.map((head, index) =>
		Math.max(head.length, ...data.map((row) => row[index].length)),
	);
	const formatRow = (cells) =>
		cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
	return [formatRow(header), ...data.map(formatRow)].join("\n");
}

/** Clamp a requested `--wait` budget to the hard cap. A non-finite or
 * non-positive value means "no waiting" (the default one-shot read). */
export function resolveWaitCapSeconds(waitSecondsArg) {
	if (!Number.isFinite(waitSecondsArg) || waitSecondsArg <= 0) return 0;
	return Math.min(waitSecondsArg, HARD_CAP_SECONDS);
}

/**
 * Poll `fetchPayload` (returns a check-runs JSON payload) until the computed
 * verdict is no longer PENDING or the wait budget is exhausted, at a fixed
 * `POLL_INTERVAL_SECONDS` interval. `sleepImpl` and `now` are injectable so
 * this is testable against a fake clock, with no real 30s wait and no
 * dependency on wall-clock timing.
 *
 * @returns {Promise<{ verdict: ReturnType<typeof computeVerdict>, polls: number }>}
 */
export async function pollVerdict({
	fetchPayload,
	waitSeconds,
	sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
}) {
	const capSeconds = resolveWaitCapSeconds(waitSeconds);
	const deadline = now() + capSeconds * 1000;
	let verdict;
	let polls = 0;
	for (;;) {
		verdict = computeVerdict(await fetchPayload());
		polls += 1;
		if (verdict.exitCode !== EXIT_PENDING) break;
		if (now() >= deadline) break;
		await sleepImpl(POLL_INTERVAL_SECONDS * 1000);
	}
	return { verdict, polls };
}

// ---------------------------------------------------------------------------
// Thin `gh` shell. No fetch, no token, no GITHUB_* env var -- `gh` on PATH is
// the only dependency (acceptance criterion), and every function below takes
// an injectable `ghExec` so the CLI orchestration stays testable too.
// ---------------------------------------------------------------------------

function gh(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function resolveRepository(ghExec = gh) {
	return ghExec([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]).trim();
}

export function resolveHeadSha(target, ghExec = gh) {
	if (isPrNumber(target)) {
		return ghExec([
			"pr",
			"view",
			String(target),
			"--json",
			"headRefOid",
			"--jq",
			".headRefOid",
		]).trim();
	}
	return String(target).trim();
}

export function fetchCheckRunsPayload(repository, sha, ghExec = gh) {
	return JSON.parse(
		ghExec([
			"api",
			`repos/${repository}/commits/${sha}/check-runs?per_page=100`,
		]),
	);
}

export function parseArgs(argv) {
	const rest = [];
	let waitSeconds = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--wait") {
			waitSeconds = Number(argv[++i]);
		} else {
			rest.push(argv[i]);
		}
	}
	return { target: rest[0] ?? null, waitSeconds };
}

async function main() {
	const { target, waitSeconds } = parseArgs(process.argv.slice(2));
	if (!target) {
		console.error(
			"usage: node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>]",
		);
		process.exitCode = 2;
		return;
	}

	const repository = resolveRepository();
	const sha = resolveHeadSha(target);

	const { verdict, polls } = await pollVerdict({
		fetchPayload: async () => fetchCheckRunsPayload(repository, sha),
		waitSeconds,
	});

	console.log(
		`CI verdict for ${repository}@${sha}${polls > 1 ? ` (${polls} reads)` : ""}`,
	);
	console.log(formatVerdictTable(verdict.rows));
	console.log(verdict.reason);
	process.exitCode = verdict.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
