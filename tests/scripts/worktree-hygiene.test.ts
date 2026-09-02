/**
 * Tests for scripts/lib/worktree-hygiene.mjs (#2435) — the PURE decision
 * layer under scripts/prune-agent-worktrees.mjs.
 *
 * Every case here is a synthetic worktree/process table in, a verdict out.
 * That is the whole point of the split: the sweep can destroy work
 * (`git worktree remove --force`) and kill processes, so the rails that stop
 * it doing so must be provable without a machine, a git repo, or a real
 * process — and mutation-provable, one test per rail, so deleting any single
 * guard reds something.
 *
 * AGENTS.md test screens: these are behavior pins at the decision layer (not
 * an implementation mirror — the assertions are on remove/keep verdicts and
 * their reasons, which is exactly what the CLI prints and acts on), with no
 * mocks, no env leakage, and no ambient inspection.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	capRemovals,
	collectAncestorPids,
	enclosingAgentWorktree,
	formatKillRecord,
	formatScanRecord,
	formatWorktreeRecord,
	isAgentBranchCandidate,
	isAgentWorktreePath,
	isFixtureHelperCommand,
	orderBySelection,
	parseDuration,
	parseLockPid,
	parseWorktreeList,
	planBranchDeletions,
	planOrphanSweep,
	planWorktreePrune,
	pruneLogLines,
	selectOrphanFixtureProcesses,
	selectProcessesUnderPath,
	selectStaleBranches,
	toComparablePath,
	verifySnapshotIntegrity,
	MAX_RECORDED_COMMAND_CHARS,
} from "../../scripts/lib/worktree-hygiene.mjs";

// A SYNTHETIC repo root, deliberately not `process.cwd()`: this suite may
// itself be running inside a `.claude/worktrees/agent-*` checkout, which
// would make the "main checkout is never an agent worktree" cases assert the
// opposite of what they mean. Anchored under os.tmpdir() so it is absolute
// (toComparablePath resolves) on Windows and POSIX alike, without existing.
const ROOT = path.join(os.tmpdir(), "pi-lens-hygiene-fixture-repo");
const wt = (name: string) => `${ROOT}/.claude/worktrees/${name}`;

const NOW = 1_800_000_000_000;
const OLD = NOW - 60 * 60_000; // an hour ago
const YOUNG = NOW - 60_000; // a minute ago

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		path: wt("agent-aaa"),
		head: "deadbeef",
		branch: "refs/heads/pr-1",
		dirty: false,
		pushed: true,
		mtimeMs: OLD,
		locked: false,
		lockPid: null,
		...overrides,
	};
}

function planOf(rows: ReturnType<typeof candidate>[], options = {}) {
	return planWorktreePrune({
		worktrees: rows as never,
		nowMs: NOW,
		isPidAlive: (pid: number) => pid === 4242,
		...options,
	});
}

const keepReason = (plan: ReturnType<typeof planOf>, path: string) =>
	plan.keep.find((entry) => entry.path === path)?.reason;

describe("planWorktreePrune — the removable case", () => {
	it("removes a clean, pushed, old agent worktree", () => {
		const plan = planOf([candidate()]);
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
		expect(plan.keep).toEqual([]);
	});
});

describe("planWorktreePrune — hard rails no flag can override", () => {
	it("never removes a dirty tree", () => {
		const plan = planOf([candidate({ dirty: true })]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("dirty");
	});

	it("keeps a dirty tree even when --only names it", () => {
		const plan = planOf([candidate({ dirty: true })], {
			only: [wt("agent-aaa")],
			minAgeMs: 0,
		});
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("dirty");
	});

	it("never removes a tree whose HEAD is not contained in an origin ref", () => {
		const plan = planOf([candidate({ pushed: false })]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("unpushed");
	});

	it("keeps an unpushed tree even when --only names it", () => {
		const plan = planOf([candidate({ pushed: false })], {
			only: [wt("agent-aaa")],
			minAgeMs: 0,
		});
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("unpushed");
	});

	it("never removes the worktree the sweep is running in", () => {
		const plan = planOf([candidate()], { selfPath: wt("agent-aaa") });
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("self");
	});

	it("protects EVERY self path (script location and cwd can differ)", () => {
		const plan = planOf([candidate(), candidate({ path: wt("agent-bbb") })], {
			selfPath: [wt("agent-aaa"), wt("agent-bbb")],
		});
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-bbb"))).toBe("self");
	});

	it("never touches a non-agent worktree (the main checkout)", () => {
		const plan = planOf([candidate({ path: ROOT })]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, ROOT)).toBe("not-agent-worktree");
	});
});

describe("planWorktreePrune — soft rails --only overrides", () => {
	it("keeps a tree younger than min-age", () => {
		const plan = planOf([candidate({ mtimeMs: YOUNG })]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("too-young");
	});

	it("removes a young tree when --only names it", () => {
		const plan = planOf([candidate({ mtimeMs: YOUNG })], {
			only: [wt("agent-aaa")],
			minAgeMs: 0,
		});
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
		expect(plan.remove[0].selected).toBe(true);
	});

	it("keeps a tree whose git lock names a LIVE pid", () => {
		const plan = planOf([candidate({ locked: true, lockPid: 4242 })]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("locked-live");
	});

	it("removes a tree whose git lock names a DEAD pid", () => {
		const plan = planOf([candidate({ locked: true, lockPid: 999 })]);
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
	});

	it("removes a live-locked tree when --only names it (the SubagentStop case)", () => {
		// The lock pid is the top-level Claude Code process, shared by every
		// agent in the session — so it is ALWAYS live at SubagentStop time. If
		// --only did not override this rail, the SubagentStop hook could never
		// clean anything up.
		const plan = planOf([candidate({ locked: true, lockPid: 4242 })], {
			only: [wt("agent-aaa")],
			minAgeMs: 0,
		});
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
	});
});

describe("planWorktreePrune — selection and budget", () => {
	it("keeps trees --only did not name", () => {
		const plan = planOf([candidate(), candidate({ path: wt("agent-bbb") })], {
			only: [wt("agent-aaa")],
			minAgeMs: 0,
		});
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
		expect(keepReason(plan, wt("agent-bbb"))).toBe("not-selected");
	});

	it("matches --only across separator and case differences", () => {
		const plan = planOf([candidate()], {
			only: [wt("agent-aaa").replace(/\//g, "\\").toUpperCase()],
			minAgeMs: 0,
		});
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
	});

	it("never removes a tree the caller ran out of budget to inspect", () => {
		// dirty/pushed are placeholders in this row; the rail must fire on
		// `unevaluated` alone, before either is consulted.
		const plan = planOf([
			candidate({ unevaluated: true, dirty: false, pushed: true }),
		]);
		expect(plan.remove).toEqual([]);
		expect(keepReason(plan, wt("agent-aaa"))).toBe("not-evaluated");
	});

	it("clamps a future mtime to age 0 rather than reporting a negative age", () => {
		const plan = planOf([candidate({ mtimeMs: NOW + 5_000 })]);
		expect(plan.keep[0].detail).toContain("age 0ms");
	});
});

describe("orderBySelection", () => {
	const rows = [
		{ path: wt("agent-aaa") },
		{ path: wt("agent-bbb") },
		{ path: wt("agent-ccc") },
	];

	it("puts --only targets first so a 2s hook budget reaches them", () => {
		expect(
			orderBySelection(rows, [wt("agent-ccc")]).map((r) => r.path),
		).toEqual([wt("agent-ccc"), wt("agent-aaa"), wt("agent-bbb")]);
	});

	it("matches a selection spelled with the other separator and casing", () => {
		expect(
			orderBySelection(rows, [
				wt("agent-bbb").replace(/\//g, "\\").toUpperCase(),
			]).map((r) => r.path),
		).toEqual([wt("agent-bbb"), wt("agent-aaa"), wt("agent-ccc")]);
	});

	it("preserves the original order when nothing is selected", () => {
		expect(orderBySelection(rows, null).map((r) => r.path)).toEqual(
			rows.map((r) => r.path),
		);
		expect(orderBySelection(rows, []).map((r) => r.path)).toEqual(
			rows.map((r) => r.path),
		);
	});

	it("does not mutate the caller's array", () => {
		const original = [...rows];
		orderBySelection(rows, [wt("agent-ccc")]);
		expect(rows).toEqual(original);
	});
});

describe("parseWorktreeList", () => {
	it("parses blocks, branches, and the Claude agent lock record", () => {
		const rows = parseWorktreeList(
			[
				`worktree ${ROOT}`,
				"HEAD aaaa",
				"branch refs/heads/master",
				"",
				`worktree ${wt("agent-zzz")}`,
				"HEAD bbbb",
				"branch refs/heads/pr-9",
				"locked claude agent agent-zzz (pid 55260)",
				"",
			].join("\n"),
		);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			path: wt("agent-zzz"),
			head: "bbbb",
			branch: "refs/heads/pr-9",
			locked: true,
			lockedReason: "claude agent agent-zzz (pid 55260)",
		});
	});

	it("handles a detached, bare, prunable and reason-less locked worktree", () => {
		const rows = parseWorktreeList(
			[
				"worktree /a",
				"HEAD cccc",
				"detached",
				"locked",
				"prunable gitdir",
				"",
			].join("\n"),
		);
		expect(rows[0]).toMatchObject({
			detached: true,
			locked: true,
			lockedReason: null,
			prunable: true,
			branch: null,
		});
	});

	it("returns nothing for empty input rather than throwing", () => {
		expect(parseWorktreeList("")).toEqual([]);
	});
});

describe("parseLockPid", () => {
	it("reads the pid out of Claude Code's lock reason", () => {
		expect(parseLockPid("claude agent agent-abc (pid 55260)")).toBe(55260);
	});

	it("returns null when there is no pid, so absence never reads as alive", () => {
		expect(parseLockPid("manually locked")).toBeNull();
		expect(parseLockPid(null)).toBeNull();
		expect(parseLockPid("pid 0")).toBeNull();
	});
});

describe("parseDuration", () => {
	it("parses ms/s/m/h and bare milliseconds", () => {
		expect(parseDuration("500")).toBe(500);
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("90s")).toBe(90_000);
		expect(parseDuration("30m")).toBe(1_800_000);
		expect(parseDuration("2h")).toBe(7_200_000);
		expect(parseDuration("0")).toBe(0);
	});

	it("returns null for garbage instead of silently defaulting", () => {
		// A mis-typed --min-age that quietly became 0 would disable the age
		// rail — so the parser must be able to say "no".
		expect(parseDuration("abc")).toBeNull();
		expect(parseDuration("-5m")).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("30 m")).toBeNull();
	});
});

describe("isAgentWorktreePath", () => {
	it("recognizes an agent worktree in both separator spellings", () => {
		expect(isAgentWorktreePath(wt("agent-abc"))).toBe(true);
		expect(isAgentWorktreePath(wt("agent-abc").replace(/\//g, "\\"))).toBe(
			true,
		);
	});

	it("rejects the main checkout and a non-agent subdirectory", () => {
		expect(isAgentWorktreePath(ROOT)).toBe(false);
		expect(isAgentWorktreePath(`${ROOT}/.claude/skills/foo`)).toBe(false);
	});
});

describe("isFixtureHelperCommand", () => {
	it("matches fixture and support helpers in either separator spelling", () => {
		expect(
			isFixtureHelperCommand("node /repo/tests/fixtures/fake-lsp-server.mjs"),
		).toBe(true);
		expect(
			isFixtureHelperCommand(String.raw`node C:\repo\tests\support\helper.mjs`),
		).toBe(true);
	});

	it("does NOT match an unrelated node process", () => {
		// The marker is the fixture DIRECTORY, never "node" — a name-based
		// match here would make the sweep a machine-wide node killer.
		expect(isFixtureHelperCommand("node /repo/clients/index.js")).toBe(false);
		expect(isFixtureHelperCommand("node")).toBe(false);
		expect(isFixtureHelperCommand("")).toBe(false);
	});

	// Both of the following were observed LIVE on the #2435 box while
	// validating the sweep: a bare `command.includes("fake-lsp-server")` was
	// satisfied by two processes that merely mention the path, and either
	// would have been killed. They are the reason the predicate also requires
	// a script runtime and rejects inline-code invocations.
	it("does NOT match the process-table QUERY that is hunting for the leak", () => {
		expect(
			isFixtureHelperCommand(
				String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*fake-lsp-server*\" }"`,
			),
		).toBe(false);
	});

	it("does NOT match a node process that merely references the fixture in -e code", () => {
		expect(
			isFixtureHelperCommand(
				String.raw`"C:\Program Files\nodejs\node.exe" -e "spawn(process.execPath,['C:\repo\tests\fixtures\fake-lsp-server.mjs'])"`,
			),
		).toBe(false);
	});

	it("still matches the real leak: a runtime launching the fixture as a script", () => {
		expect(
			isFixtureHelperCommand(
				String.raw`"C:\Program Files\nodejs\node.exe" C:\repo\tests\fixtures\fake-lsp-server.mjs`,
			),
		).toBe(true);
		expect(
			isFixtureHelperCommand("bun /repo/tests/support/helper.mjs --port 0"),
		).toBe(true);
	});

	it("does NOT match a shell or editor whose argv mentions the fixture", () => {
		expect(isFixtureHelperCommand("grep -rn fake /repo/tests/fixtures/")).toBe(
			false,
		);
		expect(isFixtureHelperCommand("/bin/sh -c 'ls tests/fixtures/'")).toBe(
			false,
		);
	});
});

describe("selectOrphanFixtureProcesses — the orphan predicate", () => {
	const table = [
		{ pid: 100, ppid: 1, command: "node /repo/scripts/vitest.mjs" },
		{
			pid: 200,
			ppid: 100,
			command: "node /repo/tests/fixtures/fake-lsp-server.mjs",
		},
		{
			pid: 300,
			ppid: 999,
			command: "node /repo/tests/fixtures/fake-lsp-server.mjs",
		},
	];

	it("kills a fixture helper whose parent is gone", () => {
		const orphans = selectOrphanFixtureProcesses(table);
		expect(orphans.map((o) => o.row.pid)).toEqual([300]);
		expect(orphans[0].reason).toContain("parent pid 999 is gone");
	});

	it("never kills a fixture helper whose parent is still alive", () => {
		const orphans = selectOrphanFixtureProcesses(table);
		expect(orphans.map((o) => o.row.pid)).not.toContain(200);
	});

	it("treats a missing/zero ppid as no live parent", () => {
		const orphans = selectOrphanFixtureProcesses([
			{ pid: 400, ppid: 0, command: "node /repo/tests/fixtures/fake.mjs" },
		]);
		expect(orphans.map((o) => o.row.pid)).toEqual([400]);
		expect(orphans[0].reason).toContain("no live parent recorded");
	});

	it("never kills itself or a protected pid", () => {
		const orphans = selectOrphanFixtureProcesses(table, {
			selfPid: 300,
		});
		expect(orphans).toEqual([]);
		expect(
			selectOrphanFixtureProcesses(table, {
				protectedPids: new Set([300]),
			}),
		).toEqual([]);
	});

	it("ignores non-fixture processes entirely", () => {
		expect(
			selectOrphanFixtureProcesses([
				{ pid: 500, ppid: 999, command: "node /repo/clients/index.js" },
			]),
		).toEqual([]);
	});
});

describe("collectAncestorPids", () => {
	const table = [
		{ pid: 1, ppid: 0, command: "init" },
		{ pid: 10, ppid: 1, command: "shell" },
		{ pid: 20, ppid: 10, command: "node hook" },
		{ pid: 30, ppid: 20, command: "node sweep" },
	];

	it("walks the whole parent chain", () => {
		expect([...collectAncestorPids(table, 30)].sort((a, b) => a - b)).toEqual([
			1, 10, 20,
		]);
	});

	it("terminates on a cyclic table instead of hanging", () => {
		const cyclic = [
			{ pid: 7, ppid: 8, command: "a" },
			{ pid: 8, ppid: 7, command: "b" },
		];
		expect([...collectAncestorPids(cyclic, 7)].sort((a, b) => a - b)).toEqual([
			8,
		]);
	});
});

describe("selectProcessesUnderPath", () => {
	const target = wt("agent-abc");
	const table = [
		{ pid: 1, ppid: 0, command: `node ${target}/scripts/x.mjs` },
		{
			pid: 2,
			ppid: 0,
			command: "node elsewhere.mjs",
			cwd: `${target}/clients`,
		},
		{ pid: 3, ppid: 0, command: "node unrelated.mjs" },
		// Sibling directory whose name merely STARTS with the target's: a
		// naive prefix match on cwd would sweep another agent's live tree.
		{ pid: 4, ppid: 0, command: "node y.mjs", cwd: `${target}2` },
	];

	it("matches by command line and by cwd", () => {
		expect(selectProcessesUnderPath(table, target).map((r) => r.pid)).toEqual([
			1, 2,
		]);
	});

	it("does not match a sibling directory sharing the path prefix", () => {
		expect(
			selectProcessesUnderPath(table, target).map((r) => r.pid),
		).not.toContain(4);
	});

	it("matches across separator and case differences", () => {
		const windowsish = table.map((row) => ({
			...row,
			command: row.command.replace(/\//g, "\\").toUpperCase(),
			cwd: row.cwd?.replace(/\//g, "\\").toUpperCase(),
		}));
		expect(
			selectProcessesUnderPath(windowsish, target).map((r) => r.pid),
		).toEqual([1, 2]);
	});

	it("never returns a protected pid", () => {
		expect(
			selectProcessesUnderPath(table, target, {
				protectedPids: new Set([1, 2]),
			}),
		).toEqual([]);
	});

	it("never returns a concurrently running copy of the sweep itself", () => {
		// A sibling sweep names the worktree it is removing on its own command
		// line; killing it mid-`git worktree remove` would leave the worktree
		// admin directory half-deleted.
		expect(
			selectProcessesUnderPath(
				[
					{
						pid: 9,
						ppid: 0,
						command: `node /repo/scripts/prune-agent-worktrees.mjs --only ${target}`,
					},
				],
				target,
			),
		).toEqual([]);
	});
});

describe("selectStaleBranches", () => {
	const base = {
		containedInOrigin: true,
		hasUpstream: true,
		upstreamGone: true,
		checkedOut: false,
	};

	it("deletes agent-session branch shapes whose upstream is gone", () => {
		expect(
			selectStaleBranches([
				{ ...base, name: "pr-2433" },
				{ ...base, name: "review/2433" },
				{ ...base, name: "fixround-2433" },
				{ ...base, name: "worktree-agent-abc" },
			]),
		).toEqual([
			"pr-2433",
			"review/2433",
			"fixround-2433",
			"worktree-agent-abc",
		]);
	});

	it("never deletes a work branch shape", () => {
		expect(
			selectStaleBranches([
				{ ...base, name: "fix/2435-worktree-hygiene" },
				{ ...base, name: "master" },
				{ ...base, name: "feat/2418-x" },
			]),
		).toEqual([]);
	});

	it("never deletes a branch whose head is not in origin", () => {
		expect(
			selectStaleBranches([
				{ ...base, name: "pr-1", containedInOrigin: false },
			]),
		).toEqual([]);
	});

	it("never deletes a branch a surviving worktree has checked out", () => {
		expect(
			selectStaleBranches([{ ...base, name: "pr-1", checkedOut: true }]),
		).toEqual([]);
	});

	it("agrees with its own cheap pre-filter on everything but containment", () => {
		// The CLI pre-filters with isAgentBranchCandidate and only then pays
		// for a containment revwalk. If the two ever disagreed on shape,
		// upstream or checked-out state, branches would be silently skipped —
		// so the pre-filter must be exactly selectStaleBranches minus
		// containment, not a second hand-maintained copy of the rules.
		const population = [
			{ ...base, name: "pr-2433" },
			{ ...base, name: "fix/2435-worktree-hygiene" },
			{ ...base, name: "pr-1", checkedOut: true },
			{ ...base, name: "pr-2", hasUpstream: true, upstreamGone: false },
			{
				...base,
				name: "worktree-agent-a",
				hasUpstream: false,
				upstreamGone: false,
			},
		];
		const viaPreFilter = population
			.filter((branch) => isAgentBranchCandidate(branch))
			.filter((branch) => branch.containedInOrigin)
			.map((branch) => branch.name);
		expect(viaPreFilter).toEqual(selectStaleBranches(population));
	});

	it("the pre-filter never depends on containment", () => {
		expect(
			isAgentBranchCandidate({
				...base,
				name: "pr-7",
				containedInOrigin: false,
			}),
		).toBe(true);
	});

	it("deletes an upstream-less snapshot branch, but not one still tracking", () => {
		expect(
			selectStaleBranches([
				{
					...base,
					name: "worktree-agent-a",
					hasUpstream: false,
					upstreamGone: false,
				},
				{ ...base, name: "pr-2", hasUpstream: true, upstreamGone: false },
			]),
		).toEqual(["worktree-agent-a"]);
	});
});

describe("bounded ledger records", () => {
	it("truncates an oversized command line", () => {
		const record = JSON.parse(
			formatKillRecord({
				pid: 1,
				command: "x".repeat(MAX_RECORDED_COMMAND_CHARS + 500),
				reason: "test",
				nowIso: "2026-09-02T00:00:00.000Z",
			}),
		);
		expect(record.command.length).toBe(MAX_RECORDED_COMMAND_CHARS + 3);
		expect(record.command.endsWith("...")).toBe(true);
	});

	it("carries the verdict fields a --quiet hook run leaves no other trace of", () => {
		const record = JSON.parse(
			formatWorktreeRecord({
				path: wt("agent-abc"),
				branch: "refs/heads/pr-1",
				ageMs: 1234.7,
				removed: true,
				nowIso: "2026-09-02T00:00:00.000Z",
			}),
		);
		expect(record).toMatchObject({
			event: "hygiene.worktree-removed",
			branch: "refs/heads/pr-1",
			ageMs: 1235,
			removed: true,
			dryRun: false,
		});
	});

	it("records a degraded process scan, so a blind sweep is not a silent one", () => {
		// A loaded box is the orphan sweep's most likely failure: the process
		// listing does not finish inside the budget, so the sweep runs blind
		// and looks clean. Without this record the only trace is a stderr line
		// the hook runner discards.
		const record = JSON.parse(
			formatScanRecord({
				reason: "skipped",
				budgetMs: 2000,
				remainingMs: 0,
				nowIso: "2026-09-02T00:00:00.000Z",
			}),
		);
		expect(record).toMatchObject({
			event: "hygiene.scan-degraded",
			reason: "skipped",
			budgetMs: 2000,
			remainingMs: 0,
			rows: 0,
		});
	});

	it("keeps only the newest maxLines records", () => {
		const existing = Array.from({ length: 10 }, (_, i) => `old-${i}`);
		const kept = pruneLogLines(existing, ["new-a", "new-b"], 5);
		expect(kept).toEqual(["old-7", "old-8", "old-9", "new-a", "new-b"]);
	});

	it("drops blank lines and tolerates a garbage bound", () => {
		expect(pruneLogLines(["a", "", "  "], ["b"], Number.NaN)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("toComparablePath", () => {
	it("normalizes separators, case, and a trailing slash to one key", () => {
		const a = toComparablePath(`${ROOT}/x/y`);
		const b = toComparablePath(`${ROOT}\\X\\Y\\`);
		expect(a).toBe(b);
	});

	it("returns an empty key for empty input rather than the cwd", () => {
		// path.resolve("") is the cwd — an empty key must never become a
		// needle that matches every process on the box.
		expect(toComparablePath("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 1 (S4, S5, S7, S8, S10)
// ---------------------------------------------------------------------------

describe("enclosingAgentWorktree (review S4)", () => {
	it("maps a subdirectory of an agent worktree to the worktree root", () => {
		expect(enclosingAgentWorktree(`${wt("agent-abc")}/tests`)).toBe(
			toComparablePath(wt("agent-abc")),
		);
	});

	it("maps the worktree root to itself", () => {
		expect(enclosingAgentWorktree(wt("agent-abc"))).toBe(
			toComparablePath(wt("agent-abc")),
		);
	});

	it("maps a deeply nested path to the worktree root", () => {
		expect(enclosingAgentWorktree(`${wt("agent-abc")}/a/b/c/d.ts`)).toBe(
			toComparablePath(wt("agent-abc")),
		);
	});

	it("returns null for a path outside every agent worktree", () => {
		expect(enclosingAgentWorktree(`${ROOT}/scripts`)).toBeNull();
		expect(enclosingAgentWorktree(ROOT)).toBeNull();
	});

	it("does not fold a sibling whose name merely extends another's", () => {
		expect(enclosingAgentWorktree(`${wt("agent-abc2")}/x`)).toBe(
			toComparablePath(wt("agent-abc2")),
		);
	});
});

describe("planWorktreePrune — the self rail is containment, not equality (review S4)", () => {
	it("keeps the tree the sweep's cwd is nested inside", () => {
		// The real caller passes [SCRIPT_DIR, process.cwd()]. SCRIPT_DIR is
		// `<worktree>/scripts` and cwd is wherever the agent invoked from —
		// neither is ever exactly the worktree root, so exact equality left the
		// sweep able to delete the tree it was running in.
		const plan = planWorktreePrune({
			worktrees: [candidate({ mtimeMs: OLD })],
			nowMs: NOW,
			selfPath: [`${wt("agent-aaa")}/scripts`, `${wt("agent-aaa")}/tests`],
		});
		expect(plan.remove).toEqual([]);
		expect(plan.keep[0]).toMatchObject({
			path: wt("agent-aaa"),
			reason: "self",
		});
	});

	it("still removes a tree when the sweep lives outside every worktree", () => {
		const plan = planWorktreePrune({
			worktrees: [candidate({ mtimeMs: OLD })],
			nowMs: NOW,
			selfPath: [`${ROOT}/scripts`, ROOT],
		});
		expect(plan.remove.map((r) => r.path)).toEqual([wt("agent-aaa")]);
	});
});

describe("selectProcessesUnderPath — a structural signal, never a mention (review S7)", () => {
	const target = wt("agent-abc");
	const select = (command: string, cwd?: string) =>
		selectProcessesUnderPath([{ pid: 42, ppid: 1, command, cwd }], target);

	it("keeps a search tool listing files under the worktree", () => {
		expect(select(`rg --files ${target}`)).toEqual([]);
	});

	it("keeps an editor holding a file inside the worktree", () => {
		expect(
			select(
				`"C:/Program Files/Microsoft VS Code/Code.exe" ${target}/README.md`,
			),
		).toEqual([]);
	});

	it("keeps a PowerShell process listing the worktree", () => {
		expect(
			select(
				`powershell.exe -NoProfile -Command "Get-ChildItem ${target} -Recurse"`,
			),
		).toEqual([]);
	});

	it("keeps a sibling-prefix worktree's own script", () => {
		expect(select(`node ${target}EXTRA/scripts/x.mjs`)).toEqual([]);
	});

	it("keeps a node -e supervisor that merely names the worktree", () => {
		expect(select(`node -e "spawn('${target}/x.mjs')"`)).toEqual([]);
	});

	it("selects a runtime running a script inside the worktree", () => {
		expect(select(`node ${target}/scripts/x.mjs`).map((r) => r.pid)).toEqual([
			42,
		]);
	});

	it("selects a binary that lives inside the worktree", () => {
		expect(
			select(`${target}/node_modules/.bin/vitest --run`).map((r) => r.pid),
		).toEqual([42]);
	});

	it("selects a process whose cwd is inside the worktree", () => {
		expect(
			select("node elsewhere.mjs", `${target}/clients`).map((r) => r.pid),
		).toEqual([42]);
	});
});

describe("verifySnapshotIntegrity / planOrphanSweep (review S5)", () => {
	const fixtureCommand = "node /repo/tests/fixtures/fake-lsp-server.mjs";
	const intact = [
		{ pid: 1, ppid: 0, command: "init" },
		{ pid: 10, ppid: 1, command: "claude" },
		{ pid: 20, ppid: 10, command: "node hook" },
		{ pid: 30, ppid: 99, command: fixtureCommand },
	];

	it("accepts a table containing this process and its whole ancestor chain", () => {
		expect(verifySnapshotIntegrity(intact, 20)).toEqual({
			ok: true,
			reason: null,
		});
	});

	it("rejects a table that does not contain this process at all", () => {
		expect(verifySnapshotIntegrity(intact, 12345)).toEqual({
			ok: false,
			reason: "self-missing",
		});
	});

	it("rejects a truncated table missing an ancestor", () => {
		const truncated = intact.filter((row) => row.pid !== 10);
		expect(verifySnapshotIntegrity(truncated, 20)).toEqual({
			ok: false,
			reason: "chain-incomplete",
		});
	});

	it("rejects an empty table", () => {
		expect(verifySnapshotIntegrity([], 20).ok).toBe(false);
	});

	it("kills nothing and records a degradation for a truncated table", () => {
		// The orphan predicate reads "parent absent from the snapshot" as
		// "parent has exited". On a TRUNCATED listing that reads every live
		// helper as an orphan — the predicate fails OPEN — so an unverifiable
		// snapshot must disable the sweep, loudly.
		const truncated = intact.filter((row) => row.pid !== 10);
		const plan = planOrphanSweep({ rows: truncated, selfPid: 20 });
		expect(plan.orphans).toEqual([]);
		expect(plan.degraded).toEqual({ reason: "chain-incomplete" });
	});

	it("kills nothing and records a degradation when the listing itself failed", () => {
		const plan = planOrphanSweep({
			rows: intact,
			selfPid: 20,
			listingOk: false,
		});
		expect(plan.orphans).toEqual([]);
		expect(plan.degraded).toEqual({ reason: "listing-failed" });
	});

	it("sweeps orphans when the snapshot verifies", () => {
		const plan = planOrphanSweep({ rows: intact, selfPid: 20 });
		expect(plan.orphans.map((o) => o.row.pid)).toEqual([30]);
		expect(plan.degraded).toBeNull();
	});

	it("restricts the sweep to one agent's tree when asked", () => {
		const tree = wt("agent-abc");
		const rows = [
			...intact,
			{
				pid: 40,
				ppid: 98,
				command: `node ${tree}/tests/fixtures/fake-lsp-server.mjs`,
			},
		];
		const plan = planOrphanSweep({ rows, selfPid: 20, restrictToPath: tree });
		expect(plan.orphans.map((o) => o.row.pid)).toEqual([40]);
		expect(plan.degraded).toBeNull();
	});
});

describe("capRemovals (review S8)", () => {
	const row = (name: string, ageMs: number) => ({
		path: wt(name),
		branch: null,
		ageMs,
		locked: false,
		selected: false,
	});
	const rows = [
		row("agent-a", 1000),
		row("agent-b", 9000),
		row("agent-c", 5000),
	];

	it("keeps only the oldest eligible tree when capped at one", () => {
		expect(capRemovals(rows, 1).map((r) => r.path)).toEqual([wt("agent-b")]);
	});

	it("returns every removal when there is no cap", () => {
		expect(capRemovals(rows, null)).toHaveLength(3);
	});

	it("does not mutate the caller's array", () => {
		const before = rows.map((r) => r.path);
		capRemovals(rows, 1);
		expect(rows.map((r) => r.path)).toEqual(before);
	});
});

describe("planBranchDeletions (review S10)", () => {
	const base = {
		containedInOrigin: true,
		hasUpstream: true,
		upstreamGone: true,
		checkedOut: false,
	};
	const branches = [
		{ ...base, name: "pr-2433" },
		{ ...base, name: "pr-2438" },
		{ ...base, name: "review/2401" },
	];

	it("deletes nothing when no worktree was removed", () => {
		expect(planBranchDeletions({ branches, removedBranchRefs: [] })).toEqual(
			[],
		);
	});

	it("deletes only the branch whose worktree was just removed", () => {
		expect(
			planBranchDeletions({
				branches,
				removedBranchRefs: ["refs/heads/pr-2433"],
			}),
		).toEqual(["pr-2433"]);
	});

	it("still refuses a branch whose head is not contained in origin", () => {
		expect(
			planBranchDeletions({
				branches: [{ ...base, name: "pr-2433", containedInOrigin: false }],
				removedBranchRefs: ["refs/heads/pr-2433"],
			}),
		).toEqual([]);
	});

	it("ignores a null branch ref left by a detached worktree", () => {
		expect(
			planBranchDeletions({ branches, removedBranchRefs: [null] }),
		).toEqual([]);
	});
});

describe("snapshot integrity — stale ppid vs truncated listing (review S5)", () => {
	// Measured on the #2435 box: the sweep's own chain is node -> bash -> bash
	// -> bash -> claude -> powershell -> WindowsTerminal -> pid 3156, and 3156
	// had genuinely exited (458-row listing, exit 0, kill(3156,0) => ESRCH).
	// Windows keeps a recorded parent pid after the parent dies, so refusing on
	// "ancestor absent" alone disables the orphan sweep on every Windows box —
	// #2435 AC 2 itself. Liveness is the discriminator.
	const chain = [
		{ pid: 3000, ppid: 2000, command: "terminal" },
		{ pid: 4000, ppid: 3000, command: "claude" },
		{ pid: 5000, ppid: 4000, command: "node sweep" },
	];
	const fixture = {
		pid: 6000,
		ppid: 5900,
		command: "node /repo/tests/fixtures/fake-lsp-server.mjs",
	};
	const rows = [...chain, fixture];

	it("accepts a chain whose missing ancestor has genuinely exited", () => {
		expect(
			verifySnapshotIntegrity(rows, 5000, { isPidAlive: () => false }),
		).toEqual({ ok: true, reason: null });
	});

	it("still refuses when the missing ancestor is alive — rows are missing", () => {
		expect(
			verifySnapshotIntegrity(rows, 5000, {
				isPidAlive: (pid) => pid === 2000,
			}),
		).toEqual({ ok: false, reason: "chain-incomplete" });
	});

	it("keeps a helper whose parent is absent from the table but still alive", () => {
		// The truncated-listing case at the level that matters: the predicate
		// must not read "absent" as "dead" when the box says otherwise.
		const plan = planOrphanSweep({
			rows,
			selfPid: 5000,
			isPidAlive: (pid) => pid === 5900,
		});
		expect(plan.orphans).toEqual([]);
		expect(plan.degraded).toBeNull();
	});

	it("reaps a helper whose parent is absent and confirmed gone", () => {
		const plan = planOrphanSweep({
			rows,
			selfPid: 5000,
			isPidAlive: () => false,
		});
		expect(plan.orphans.map((o) => o.row.pid)).toEqual([6000]);
	});
});
