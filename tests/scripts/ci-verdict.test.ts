import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	DEFAULT_GH_TIMEOUT_MS,
	EXIT_DIRTY,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	EXIT_USAGE,
	fetchCheckRunsPayload,
	formatVerdictTable,
	HARD_CAP_SECONDS,
	isPrNumber,
	MIN_GH_TIMEOUT_MS,
	parseArgs,
	pollVerdict,
	POLL_INTERVAL_SECONDS,
	resolveGhTimeoutMs,
	resolveHeadSha,
	resolveRepository,
	resolveWaitCapSeconds,
	run,
} from "../../scripts/ci-verdict.mjs";

function checkRun({
	name,
	status = "completed",
	conclusion = "success",
	started_at = "2026-09-03T00:00:00Z",
	id = 1,
	html_url = `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
}: {
	name: string;
	status?: string;
	conclusion?: string | null;
	started_at?: string;
	id?: number;
	html_url?: string;
}) {
	return { name, status, conclusion, started_at, id, html_url };
}

const BOTH_SUCCESS = {
	check_runs: [
		checkRun({ name: "Unit tests", id: 1 }),
		checkRun({ name: "Lint & type-check", id: 2 }),
	],
};

describe("computeVerdict — the four exit codes (#2539 acceptance criterion)", () => {
	it("exits 0 when both required checks concluded success", () => {
		const verdict = computeVerdict(BOTH_SUCCESS);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		expect(verdict.rows.every((row) => row.present)).toBe(true);
	});

	it("exits 1 when a required check completed with a non-success conclusion", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", conclusion: "failure", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
	});

	it("exits 3 while a required check is still queued or in_progress", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					id: 1,
				}),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});
});

// #2539 round 2, F1: absent is not automatically DIRTY. `ci-verdict.mjs:116-120`
// pre-fix exited 2 the instant a required check was absent from the payload,
// without ever asking GitHub whether the PR was actually merge-conflicted --
// the common cause of an absent check is CI not yet registered (a fresh
// push), which `pollVerdict`'s break-on-any-non-pending-verdict loop could
// then never bridge with `--wait`. Fixed via `mergeable` threaded from
// `gh pr view --json headRefOid,mergeable` through to `computeVerdict`.
describe("computeVerdict — absent-check verdict is mergeable-aware (#2539 round 2, F1)", () => {
	it("A1: exits 3 (pending) when a required check is absent but the PR is MERGEABLE", () => {
		const payload = {
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const lint = verdict.rows.find((row) => row.name === "Lint & type-check");
		expect(lint?.present).toBe(false);
	});

	it("A2: exits 2 (DIRTY) when a required check is absent AND the PR is CONFLICTING", () => {
		const payload = {
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		const verdict = computeVerdict(payload, undefined, "CONFLICTING");
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
	});

	it("A3: exits 3 (pending) when the target is a bare SHA (mergeable=null, no PR context)", () => {
		const verdict = computeVerdict({ check_runs: [] }, undefined, null);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toMatch(/no PR context/);
	});

	it("also reads UNKNOWN mergeable as pending, not DIRTY", () => {
		const verdict = computeVerdict(
			{ check_runs: [checkRun({ name: "Unit tests", id: 1 })] },
			undefined,
			"UNKNOWN",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});

	it("DIRTY still takes priority over an independently failed sibling check, when CONFLICTING", () => {
		const payload = {
			check_runs: [
				// Unit tests absent entirely; Lint failed outright. Confirmed
				// conflict must still win over the sibling's concrete failure.
				checkRun({ name: "Lint & type-check", conclusion: "failure", id: 2 }),
			],
		};
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});

	it("a non-conflicting absence yields FAILURE, not PENDING, when the sibling concretely failed", () => {
		// Unlike the CONFLICTING case above: with no confirmed conflict, a
		// concrete failure on the other required check is real evidence and
		// must not be masked by an absent check that's merely unregistered.
		const payload = {
			check_runs: [
				checkRun({ name: "Lint & type-check", conclusion: "failure", id: 2 }),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_FAILURE,
		);
	});
});

// #2539 round 3, F1: round 2's DIRTY gate was `anyAbsent && mergeable ===
// "CONFLICTING"`, so the DOMINANT DIRTY shape -- a head that went green and
// only turned conflicted AFTERWARD, same head SHA, old green check-runs
// still attached -- read as a pass. A live probe on #2552 confirmed exit 0
// ("both required checks concluded success") on a present-and-green PR that
// `gh pr view` reported as CONFLICTING. DIRTY must fire from `mergeable`
// alone, independent of whether the required checks are present.
describe("computeVerdict — DIRTY fires on CONFLICTING regardless of check presence (#2539 round 3, F1)", () => {
	it("exits 2 (DIRTY) when both required checks are present and green but the PR is CONFLICTING", () => {
		const verdict = computeVerdict(BOTH_SUCCESS, undefined, "CONFLICTING");
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
		expect(verdict.rows.every((row) => row.present)).toBe(true);
		expect(verdict.rows.every((row) => row.conclusion === "success")).toBe(
			true,
		);
	});

	it("the verdict record always carries mergeState, even off the DIRTY path", () => {
		expect(
			computeVerdict(BOTH_SUCCESS, undefined, "CONFLICTING").mergeState,
		).toBe("CONFLICTING");
		expect(
			computeVerdict(BOTH_SUCCESS, undefined, "MERGEABLE").mergeState,
		).toBe("MERGEABLE");
		// Bare-SHA target: no PR context, mergeable is null -- reported as
		// "n/a", and DIRTY documented as PR-only: null can never equal the
		// literal string "CONFLICTING".
		expect(computeVerdict(BOTH_SUCCESS, undefined, null).mergeState).toBe(
			"n/a",
		);
		expect(computeVerdict(BOTH_SUCCESS, undefined, null).exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("run() prints the merge state line unconditionally, including on a clean pass", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(stdoutLines).toContain("Merge state: MERGEABLE");
	});

	it("run() exits 2 end to end for a present-and-green PR that is CONFLICTING (#2552 live-probe shape)", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "CONFLICTING",
				});
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_DIRTY);
		expect(stdoutLines).toContain("Merge state: CONFLICTING");
	});
});

// #2539 round 2, F7: `per_page=100` is not paginated, but `total_count` in
// the same response says whether the fetched page was actually complete.
describe("computeVerdict — truncated check-runs response (#2539 round 2, F7)", () => {
	it("exits 3 (pending), not DIRTY, when total_count exceeds the fetched check_runs", () => {
		const payload = {
			total_count: 150,
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		// Even with a confirmed conflict, truncation wins: the missing required
		// check might simply be sitting past the fetched page.
		const verdict = computeVerdict(payload, undefined, "CONFLICTING");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toMatch(/truncated/);
	});

	it("total_count equal to the fetched count is NOT truncated", () => {
		const payload = { total_count: 2, ...BOTH_SUCCESS };
		expect(computeVerdict(payload).exitCode).toBe(EXIT_SUCCESS);
	});

	it("a non-numeric total_count is ignored, not treated as truncation", () => {
		// A malformed real-world payload (the field is present but not a
		// number) -- deliberately mistyped to exercise computeVerdict's own
		// `typeof totalCount === "number"` runtime guard.
		const payload = {
			total_count: "not-a-number" as unknown as number,
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});
});

describe("computeVerdict — rerun de-duplication (latest-started wins)", () => {
	it("picks the most recently started run when a name appears twice (a rerun)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					conclusion: "failure",
					started_at: "2026-09-03T00:00:00Z",
					id: 1,
				}),
				checkRun({
					name: "Unit tests",
					conclusion: "success",
					started_at: "2026-09-03T01:00:00Z",
					id: 2,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.conclusion).toBe("success");
	});

	// #2539 round 2, F5 (reviewer probe): the live REST API returns check-runs
	// NEWEST-FIRST, but the single pre-round-2 fixture above only covered
	// older-then-newer array order. A `matches[matches.length - 1]` ("last
	// wins") tiebreak stays green on that one fixture while getting the real
	// API's order backwards -- it would report the STALE failing run instead
	// of the fix-confirming success. Reversed order must resolve identically.
	it("resolves identically when the rerun array is newest-first (the live API's own order)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Lint & type-check", id: 3 }),
				checkRun({
					name: "Unit tests",
					conclusion: "success",
					started_at: "2026-09-03T01:00:00Z",
					id: 2,
				}),
				checkRun({
					name: "Unit tests",
					conclusion: "failure",
					started_at: "2026-09-03T00:00:00Z",
					id: 1,
				}),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.conclusion).toBe("success");
	});

	// #2539 round 2, F2/F5: the shared `resolveLatestByName` tie policy
	// (scripts/lib/ci-checks.mjs) is fail-closed, not id-based. A superseded
	// SUCCESS carrying the HIGHER id, or a duplicate with no `started_at` at
	// all, must not read as success -- both are covered again here (beyond
	// merge-train-warden.test.ts's own coverage of the shared resolver)
	// because ci-verdict.mjs is what actually calls it with REST-shaped runs.
	it("does not let a superseded success with the higher id win an unorderable tie (in_progress first)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					started_at: "",
					id: 1,
				}),
				checkRun({
					name: "Unit tests",
					status: "completed",
					conclusion: "success",
					started_at: "",
					id: 99,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.status).toBe("in_progress");
	});

	// #2539 round 3: the case above happens to also put the correct winner
	// (in_progress) FIRST in array order, so it cannot distinguish the real
	// fail-closed policy (non-success wins an unorderable tie, per
	// preferCheckRun in scripts/lib/ci-checks.mjs) from a regression to
	// "array position first wins" -- both would return in_progress there.
	// Swapping the order (success first, in_progress LAST) forces them apart:
	// a first-wins bug would return success here; the real fail-closed policy
	// still returns in_progress regardless of position.
	it("does not let a superseded success with the higher id win an unorderable tie (in_progress last)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "completed",
					conclusion: "success",
					started_at: "",
					id: 99,
				}),
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					started_at: "",
					id: 1,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.status).toBe("in_progress");
	});
});

describe("formatVerdictTable", () => {
	it("renders a fixed CHECK/STATUS/CONCLUSION/URL table", () => {
		const verdict = computeVerdict(BOTH_SUCCESS);
		const table = formatVerdictTable(verdict.rows);
		const lines = table.split("\n");
		expect(lines[0]).toMatch(/^CHECK\s+STATUS\s+CONCLUSION\s+URL\s*$/);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("Unit tests");
		expect(lines[2]).toContain("Lint & type-check");
	});

	it("shows an absent required check as 'absent' with no conclusion or URL", () => {
		const verdict = computeVerdict({ check_runs: [] });
		const table = formatVerdictTable(verdict.rows);
		for (const line of table.split("\n").slice(1)) {
			expect(line).toContain("absent");
		}
	});
});

describe("isPrNumber", () => {
	it.each(["2539", "1", "000123"])("treats %s as a PR number", (value) => {
		expect(isPrNumber(value)).toBe(true);
	});

	it.each(["abc1234", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", ""])(
		"treats %s as sha-shaped, not a PR number",
		(value) => {
			expect(isPrNumber(value)).toBe(false);
		},
	);
});

describe("resolveWaitCapSeconds — the hard cap", () => {
	it("clamps a requested wait above the hard cap down to the hard cap", () => {
		expect(resolveWaitCapSeconds(HARD_CAP_SECONDS * 10)).toBe(HARD_CAP_SECONDS);
	});

	it("passes a requested wait under the cap through unchanged", () => {
		expect(resolveWaitCapSeconds(60)).toBe(60);
	});

	it("treats a missing/non-positive wait as no waiting at all", () => {
		expect(resolveWaitCapSeconds(null as unknown as number)).toBe(0);
		expect(resolveWaitCapSeconds(0)).toBe(0);
		expect(resolveWaitCapSeconds(-5)).toBe(0);
		expect(resolveWaitCapSeconds(Number.NaN)).toBe(0);
	});
});

describe("pollVerdict", () => {
	it("does exactly ONE fetch by default (no --wait): the issue's baseline promise", async () => {
		let calls = 0;
		const fetchPayload = async () => {
			calls += 1;
			return {
				check_runs: [
					checkRun({
						name: "Unit tests",
						status: "in_progress",
						conclusion: null,
						id: 1,
					}),
					checkRun({ name: "Lint & type-check", id: 2 }),
				],
			};
		};
		const { verdict, polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
		});
		expect(calls).toBe(1);
		expect(polls).toBe(1);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});

	it("stops polling immediately once the verdict is no longer pending", async () => {
		// Fake clock (not real Date.now): a mutant that drops the
		// exitCode!==EXIT_PENDING stop condition would otherwise busy-loop for
		// the full real 300s wait budget before this test could catch it.
		let clock = 0;
		let calls = 0;
		let sleeps = 0;
		const fetchPayload = async () => {
			calls += 1;
			return BOTH_SUCCESS;
		};
		const { polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: 300,
			now: () => clock,
			sleepImpl: async (ms: number) => {
				sleeps += 1;
				clock += ms;
			},
		});
		expect(calls).toBe(1);
		expect(polls).toBe(1);
		expect(sleeps).toBe(0);
	});

	it("polls at the fixed >=30s interval, bounded by the hard cap, while pending", async () => {
		let clock = 0;
		const now = () => clock;
		let sleeps = 0;
		const sleepIntervals: number[] = [];
		const fetchPayload = async () => ({
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					id: 1,
				}),
				checkRun({
					name: "Lint & type-check",
					status: "in_progress",
					conclusion: null,
					id: 2,
				}),
			],
		});
		const sleepImpl = async (ms: number) => {
			sleeps += 1;
			sleepIntervals.push(ms);
			clock += ms;
		};
		const requestedWaitSeconds = HARD_CAP_SECONDS * 100; // wildly over the cap
		const { verdict, polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: requestedWaitSeconds,
			sleepImpl,
			now,
		});
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		// Bounded by HARD_CAP_SECONDS, not the wildly larger requested wait.
		const expectedSleeps = Math.floor(HARD_CAP_SECONDS / POLL_INTERVAL_SECONDS);
		expect(sleeps).toBe(expectedSleeps);
		expect(polls).toBe(expectedSleeps + 1);
		expect(
			sleepIntervals.every((ms) => ms === POLL_INTERVAL_SECONDS * 1000),
		).toBe(true);
	});

	// #2539 round 2, F1: `mergeable` must actually reach `computeVerdict`
	// through the poll loop, not just be accepted as a dead parameter.
	it("threads `mergeable` through to computeVerdict on every read", async () => {
		const fetchPayload = async () => ({
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		});
		const conflicting = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
			mergeable: "CONFLICTING",
		});
		expect(conflicting.verdict.exitCode).toBe(EXIT_DIRTY);
		const mergeableOne = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
			mergeable: "MERGEABLE",
		});
		expect(mergeableOne.verdict.exitCode).toBe(EXIT_PENDING);
	});

	// #2539 round 2, F4: `fetchPayload` must receive the remaining wait budget
	// so a caller can derive a `gh` call's own timeout from it. `undefined` on
	// a one-shot read (no `--wait` at all); a decreasing number while polling.
	it("passes the remaining wait budget to fetchPayload, undefined with no --wait", async () => {
		const remainingArgs: (number | undefined)[] = [];
		await pollVerdict({
			fetchPayload: async (remainingMs) => {
				remainingArgs.push(remainingMs);
				return BOTH_SUCCESS;
			},
			waitSeconds: null,
		});
		expect(remainingArgs).toEqual([undefined]);

		let clock = 0;
		const waitArgs: (number | undefined)[] = [];
		await pollVerdict({
			fetchPayload: async (remainingMs) => {
				waitArgs.push(remainingMs);
				return clock === 0
					? {
							check_runs: [
								checkRun({
									name: "Unit tests",
									status: "in_progress",
									conclusion: null,
									id: 1,
								}),
								checkRun({ name: "Lint & type-check", id: 2 }),
							],
						}
					: BOTH_SUCCESS;
			},
			waitSeconds: 60,
			now: () => clock,
			sleepImpl: async (ms: number) => {
				clock += ms;
			},
		});
		expect(waitArgs).toEqual([60_000, 30_000]);
	});
});

describe("resolveGhTimeoutMs — the derived per-call gh timeout (#2539 round 2, F4)", () => {
	it("falls back to the flat default with no wait budget (undefined/null, not a number)", () => {
		expect(resolveGhTimeoutMs(undefined)).toBe(DEFAULT_GH_TIMEOUT_MS);
		expect(resolveGhTimeoutMs(null as unknown as number)).toBe(
			DEFAULT_GH_TIMEOUT_MS,
		);
	});

	it("uses the remaining budget when it is between the floor and the default", () => {
		expect(resolveGhTimeoutMs(5_000)).toBe(5_000);
		expect(resolveGhTimeoutMs(30_000)).toBe(30_000);
	});

	it("clamps to the default when the remaining budget is larger", () => {
		expect(resolveGhTimeoutMs(HARD_CAP_SECONDS * 1000)).toBe(
			DEFAULT_GH_TIMEOUT_MS,
		);
	});
});

// #2539 round 3, F2: `resolveGhTimeoutMs` clamped straight to the literal
// remaining budget with no floor. A probe on `--wait 31` derived a 50ms
// timeout for the last poll and killed a healthy ~950ms `gh` call (exit 70
// over a genuinely green head). Separately, a budget already at its deadline
// (remainingMs === 0) fell through the `remainingMs > 0` guard to the FULL
// 60s default -- the opposite failure, on the very call meant to end the
// wait. `MIN_GH_TIMEOUT_MS` floors both.
describe("resolveGhTimeoutMs — floored at MIN_GH_TIMEOUT_MS (#2539 round 3, F2)", () => {
	it("floors a tiny positive remainder up to MIN_GH_TIMEOUT_MS instead of killing a healthy call", () => {
		// `--wait 31` on the last poll: 31s cap, 30.95s already spent sleeping
		// at the fixed 30s interval, ~50ms left -- the exact live-probe shape.
		expect(resolveGhTimeoutMs(50)).toBe(MIN_GH_TIMEOUT_MS);
		expect(resolveGhTimeoutMs(1)).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("floors an exhausted budget (remainingMs === 0) instead of granting the full 60s default", () => {
		// The deadline is already reached -- this is the LAST call before
		// giving up, and it must not itself get a fresh 60s timeout that could
		// blow the `--wait` budget it was derived from.
		expect(resolveGhTimeoutMs(0)).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("MIN_GH_TIMEOUT_MS is well under DEFAULT_GH_TIMEOUT_MS and the hard cap", () => {
		expect(MIN_GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MIN_GH_TIMEOUT_MS).toBeLessThan(DEFAULT_GH_TIMEOUT_MS);
	});
});

describe("fetchCheckRunsPayload — timeout wiring (#2539 round 2, F4)", () => {
	it("passes the timeoutMs through to ghExec's own options", () => {
		const calls: Array<{ args: string[]; options: unknown }> = [];
		const ghExec = (args: string[], options: unknown) => {
			calls.push({ args, options });
			return JSON.stringify({ check_runs: [] });
		};
		fetchCheckRunsPayload("acme/repo", "deadbeef", ghExec, 12_345);
		expect(calls).toHaveLength(1);
		expect(calls[0].options).toEqual({ timeoutMs: 12_345 });
		expect(calls[0].args).toEqual([
			"api",
			"repos/acme/repo/commits/deadbeef/check-runs?per_page=100",
		]);
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ check_runs: [] });
		};
		fetchCheckRunsPayload("acme/repo", "deadbeef", ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

describe("resolveRepository", () => {
	it("resolves and trims the gh CLI's own nameWithOwner jq output", () => {
		const ghExec = (args: string[]) => {
			expect(args).toEqual([
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"--jq",
				".nameWithOwner",
			]);
			return "acme/repo\n";
		};
		expect(resolveRepository(ghExec)).toBe("acme/repo");
	});

	// #2539 round 3, F2: this call used to fire with NO options at all, so it
	// fell back to the `gh()` wrapper's own default (a flat 60s) with no
	// relationship whatsoever to `--wait` -- the same gap F4 closed for the
	// check-runs read, just missed here.
	it("passes the timeoutMs through to ghExec's own options", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return "acme/repo";
		};
		resolveRepository(ghExec, 12_345);
		expect(calls[0]).toEqual({ timeoutMs: 12_345 });
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return "acme/repo";
		};
		resolveRepository(ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

describe("resolveHeadSha — mergeable resolution (#2539 round 2, F1)", () => {
	it("resolves sha AND mergeable via ONE gh pr view call for a PR number", () => {
		const calls: string[][] = [];
		const ghExec = (args: string[]) => {
			calls.push(args);
			return JSON.stringify({
				headRefOid: "c0ffee123456",
				mergeable: "CONFLICTING",
			});
		};
		const result = resolveHeadSha("2539", ghExec);
		expect(result).toEqual({ sha: "c0ffee123456", mergeable: "CONFLICTING" });
		expect(calls).toEqual([
			["pr", "view", "2539", "--json", "headRefOid,mergeable"],
		]);
	});

	it("returns mergeable: null for a bare SHA target, with no gh call at all", () => {
		const ghExec = () => {
			throw new Error("must not call gh for a bare SHA target");
		};
		expect(resolveHeadSha("abc1234", ghExec)).toEqual({
			sha: "abc1234",
			mergeable: null,
		});
	});

	// #2539 round 3, F2: same gap as resolveRepository above.
	it("passes the timeoutMs through to ghExec's own options for a PR-number target", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
		};
		resolveHeadSha("2539", ghExec, 12_345);
		expect(calls[0]).toEqual({ timeoutMs: 12_345 });
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
		};
		resolveHeadSha("2539", ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

// #2539 round 3, F2: `run()` must derive resolveRepository/resolveHeadSha's
// timeout from the FULL clamped `--wait` budget (nothing spent yet when
// they fire), not the flat default -- otherwise a small `--wait` still lets
// an unbounded 60s hang on either of these two calls blow the whole budget
// before polling even starts.
describe("run — resolveRepository/resolveHeadSha get a --wait-derived timeout (#2539 round 3, F2)", () => {
	it("derives the initial timeout from the full --wait cap, floored at MIN_GH_TIMEOUT_MS", async () => {
		const seenTimeouts: unknown[] = [];
		const ghExec = (args: string[], options?: { timeoutMs?: number }) => {
			seenTimeouts.push(options?.timeoutMs);
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		await run({
			argv: ["2539", "--wait", "1"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
		});
		// --wait 1 (1s = 1000ms) is under MIN_GH_TIMEOUT_MS, so both the
		// repository and PR-view calls must floor to MIN_GH_TIMEOUT_MS, not
		// clamp down to 1000ms and not fall back to the 60s default.
		expect(seenTimeouts[0]).toBe(MIN_GH_TIMEOUT_MS);
		expect(seenTimeouts[1]).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("falls back to the flat default with no --wait", async () => {
		const seenTimeouts: unknown[] = [];
		const ghExec = (args: string[], options?: { timeoutMs?: number }) => {
			seenTimeouts.push(options?.timeoutMs);
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		await run({
			argv: ["2539"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
		});
		expect(seenTimeouts[0]).toBe(DEFAULT_GH_TIMEOUT_MS);
		expect(seenTimeouts[1]).toBe(DEFAULT_GH_TIMEOUT_MS);
	});
});

describe("run — exit codes distinct from verdict codes (#2539 round 2, F3)", () => {
	it("exits 64 (usage) with no target, before any gh call", async () => {
		const ghExec = () => {
			throw new Error("must not call gh on a usage error");
		};
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: [],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
		});
		expect(exitCode).toBe(EXIT_USAGE);
		expect(exitCode).not.toBe(EXIT_DIRTY); // 64, never collides with 2
		expect(stderrLines.join("\n")).toMatch(/usage:/);
	});

	it("exits 70 (transport), not 1, when gh itself fails", async () => {
		const ghExec = () => {
			throw new Error("gh: command not found");
		};
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(exitCode).not.toBe(EXIT_FAILURE); // 70, never collides with 1
		expect(stderrLines.join("\n")).toMatch(/command not found/);
	});

	it("returns the real verdict exit code end to end for a healthy PR", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "MERGEABLE",
				});
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(stdoutLines.join("\n")).toContain("acme/repo@c0ffee");
	});
});

describe("parseArgs", () => {
	it("parses the positional target and an optional --wait value", () => {
		expect(parseArgs(["2539"])).toEqual({ target: "2539", waitSeconds: null });
		expect(parseArgs(["2539", "--wait", "60"])).toEqual({
			target: "2539",
			waitSeconds: 60,
		});
		expect(parseArgs(["abc1234", "--wait", "90"])).toEqual({
			target: "abc1234",
			waitSeconds: 90,
		});
	});

	it("returns a null target when no positional argument is given", () => {
		expect(parseArgs([])).toEqual({ target: null, waitSeconds: null });
	});
});
