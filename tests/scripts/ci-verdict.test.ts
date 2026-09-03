import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_DIRTY,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	formatVerdictTable,
	HARD_CAP_SECONDS,
	isPrNumber,
	parseArgs,
	pollVerdict,
	POLL_INTERVAL_SECONDS,
	resolveWaitCapSeconds,
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

	it("exits 2 when a required check is ABSENT from check-runs (DIRTY PR)", () => {
		const payload = {
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
		const lint = verdict.rows.find((row) => row.name === "Lint & type-check");
		expect(lint?.present).toBe(false);
	});

	it("exits 2 when check-runs is entirely empty (fully DIRTY PR, no runs registered at all)", () => {
		const verdict = computeVerdict({ check_runs: [] });
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
		expect(verdict.rows.every((row) => !row.present)).toBe(true);
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

	it("DIRTY takes priority over an independently failed or pending sibling check", () => {
		const payload = {
			check_runs: [
				// Unit tests absent entirely; Lint failed outright. Absence must win.
				checkRun({ name: "Lint & type-check", conclusion: "failure", id: 2 }),
			],
		};
		expect(computeVerdict(payload).exitCode).toBe(EXIT_DIRTY);
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
