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
	collectAncestorPids,
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
	planWorktreePrune,
	pruneLogLines,
	selectOrphanFixtureProcesses,
	selectProcessesUnderPath,
	selectStaleBranches,
	toComparablePath,
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
