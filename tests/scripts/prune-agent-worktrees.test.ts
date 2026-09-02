/**
 * Tests for the CLI seams of scripts/prune-agent-worktrees.mjs (#2435).
 *
 * The destructive logic lives in scripts/lib/worktree-hygiene.mjs and is
 * covered by worktree-hygiene.test.ts. What is left here is the surface that
 * decides HOW that logic is invoked — argument parsing, the SubagentStop
 * payload mapping, the worktree-activity rail that decides age, and the
 * ledger location. The platform process-table parsers moved to
 * tests/scripts/process-scan.test.ts with the listing itself (review round
 * 3, F2). Importing the module runs no sweep: its `isEntryPoint()` guard
 * is false under vitest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_HOOK_BUDGET_MS,
	DEFAULT_MANUAL_BUDGET_MS,
	REMOVE_TIMEOUT_MS,
	getHygieneLogPath,
	parseArgs,
	resolveHookPolicy,
	worktreeActivityMs,
	worktreePathFromHookPayload,
} from "../../scripts/prune-agent-worktrees.mjs";
import {
	DEFAULT_MIN_AGE_MS,
	planWorktreePrune,
} from "../../scripts/lib/worktree-hygiene.mjs";
import { gitExecFileSync } from "../support/git-fixture-env.js";

describe("parseArgs", () => {
	it("defaults to a non-destructive-by-omission configuration", () => {
		const options = parseArgs([]);
		expect(options).toMatchObject({
			dryRun: false,
			minAgeMs: DEFAULT_MIN_AGE_MS,
			budgetMs: null,
			only: null,
			hook: null,
			orphanSweep: true,
			errors: [],
		});
	});

	it("parses the flags the hooks and a human actually pass", () => {
		const options = parseArgs([
			"--dry-run",
			"--min-age",
			"90s",
			"--only",
			"/a",
			"--only",
			"/b",
			"--hook",
			"subagent-stop",
			"--budget-ms",
			"5s",
			"--no-orphan-sweep",
			"--json",
			"--quiet",
		]);
		expect(options).toMatchObject({
			dryRun: true,
			minAgeMs: 90_000,
			budgetMs: 5_000,
			only: ["/a", "/b"],
			hook: "subagent-stop",
			orphanSweep: false,
			json: true,
			quiet: true,
			errors: [],
		});
	});

	it("rejects a mis-typed --min-age instead of silently disabling the age rail", () => {
		const options = parseArgs(["--min-age", "thirty-minutes"]);
		expect(options.errors).toEqual(["invalid --min-age value: thirty-minutes"]);
		expect(options.minAgeMs).toBe(DEFAULT_MIN_AGE_MS);
	});

	it("rejects a zero or unparseable --budget-ms", () => {
		expect(parseArgs(["--budget-ms", "0"]).errors).toHaveLength(1);
		expect(parseArgs(["--budget-ms", "soon"]).errors).toHaveLength(1);
	});

	it("rejects an unknown hook event and an unknown flag", () => {
		expect(parseArgs(["--hook", "PreToolUse"]).errors).toEqual([
			"unknown --hook event: PreToolUse",
		]);
		expect(parseArgs(["--delete-everything"]).errors).toEqual([
			"unknown argument: --delete-everything",
		]);
	});

	it("keeps the hook budget well under the 2s the issue requires", () => {
		expect(DEFAULT_HOOK_BUDGET_MS).toBeLessThanOrEqual(2_000);
		expect(DEFAULT_MANUAL_BUDGET_MS).toBeGreaterThan(DEFAULT_HOOK_BUDGET_MS);
	});
});

describe("worktreePathFromHookPayload", () => {
	const repoRoot = path.resolve("/repo");

	it("maps a SubagentStop payload's agent_id to that agent's worktree", () => {
		expect(
			worktreePathFromHookPayload(
				{ hook_event_name: "SubagentStop", agent_id: "a185ed4e565ad3d4d" },
				repoRoot,
			),
		).toBe(
			path.join(repoRoot, ".claude", "worktrees", "agent-a185ed4e565ad3d4d"),
		);
	});

	it("returns null when the payload carries no usable agent id", () => {
		// Then the caller falls back to the default sweep rather than guessing
		// which tree the finished agent owned.
		expect(worktreePathFromHookPayload(null, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload({}, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload({ agent_id: 42 }, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload("nonsense", repoRoot)).toBeNull();
	});

	it("refuses an agent id that could escape the worktrees directory", () => {
		for (const agentId of ["../../..", "a/../../b", "a\\b", "with space", ""]) {
			expect(worktreePathFromHookPayload({ agent_id: agentId }, repoRoot)).toBe(
				null,
			);
		}
	});
});

describe("getHygieneLogPath", () => {
	const saved = {
		data: process.env.PILENS_DATA_DIR,
		home: process.env.PI_LENS_HOME,
	};

	beforeEach(() => {
		delete process.env.PILENS_DATA_DIR;
		delete process.env.PI_LENS_HOME;
	});

	afterEach(() => {
		if (saved.data === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = saved.data;
		if (saved.home === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = saved.home;
	});

	it("falls back to ~/.pi-lens/hygiene.log", () => {
		expect(getHygieneLogPath()).toBe(
			path.join(os.homedir(), ".pi-lens", "hygiene.log"),
		);
	});

	it("honors PI_LENS_HOME", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-hyg-home-"));
		try {
			process.env.PI_LENS_HOME = dir;
			expect(getHygieneLogPath()).toBe(path.join(dir, "hygiene.log"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers PILENS_DATA_DIR over PI_LENS_HOME", () => {
		process.env.PI_LENS_HOME = path.join(os.tmpdir(), "home-should-lose");
		process.env.PILENS_DATA_DIR = path.join(os.tmpdir(), "data-should-win");
		expect(getHygieneLogPath()).toBe(
			path.join(os.tmpdir(), "data-should-win", "hygiene.log"),
		);
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 1 (S1, S8, S9)
// ---------------------------------------------------------------------------

describe("resolveHookPolicy (review S1/S8)", () => {
	it("never removes a worktree on SubagentStop", () => {
		// Resume-by-SendMessage happens AFTER SubagentStop, and
		// .claude/skills/merge-train/SKILL.md keeps fixer worktrees until the
		// PR merges. So the subagent-stop hook only reaps that agent's own
		// dead-parent fixture helpers; removal is the session-start sweep's job.
		expect(resolveHookPolicy("subagent-stop")).toMatchObject({
			removeWorktrees: false,
			deleteBranches: false,
			orphanSweep: true,
			scopedToAgentTree: true,
			maxRemovals: 0,
		});
	});

	it("removes at most one tree per SessionStart run", () => {
		// The hook has a hard wall-clock timeout and `git worktree remove` is
		// bounded at REMOVE_TIMEOUT_MS; more than one removal per run cannot fit
		// inside any sane hook timeout, and a SIGKILLed removal leaves a
		// half-removed tree.
		expect(resolveHookPolicy("session-start")).toMatchObject({
			removeWorktrees: true,
			deleteBranches: true,
			scopedToAgentTree: false,
			maxRemovals: 1,
		});
	});

	it("leaves a manual run uncapped", () => {
		// Uncapped is Infinity, not a falsy number (review round 3, F4):
		// capRemovals now reads 0 as ZERO, so uncapped had to stop being
		// spelled by anything that could be confused with it.
		expect(resolveHookPolicy(null)).toMatchObject({
			removeWorktrees: true,
			deleteBranches: true,
			scopedToAgentTree: false,
			maxRemovals: Number.POSITIVE_INFINITY,
		});
	});

	it("treats an unknown event as a manual run rather than a destructive one", () => {
		expect(resolveHookPolicy("who-knows")).toEqual(resolveHookPolicy(null));
	});
});

describe(".claude/settings.json hook registration (review S8/S9)", () => {
	const settingsPath = path.resolve(__dirname, "../../.claude/settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

	it("tracks hooks only — permissions stay in the ignored settings.local.json", () => {
		// The maintainer's own .claude/settings.json holds a permissions.allow
		// list. Tracking anything but hooks here would collide with it on merge.
		expect(Object.keys(settings).sort()).toEqual(["$schema", "hooks"]);
	});

	it("gives SessionStart room to finish one bounded worktree removal", () => {
		const timeoutS = settings.hooks.SessionStart[0].hooks[0].timeout;
		expect(timeoutS * 1000).toBeGreaterThanOrEqual(REMOVE_TIMEOUT_MS + 10_000);
	});

	it("runs the sweep on startup and resume only (review round 3, F1c)", () => {
		// Without a matcher, SessionStart fires for `clear`, `compact` and
		// `fork` too — so a long session re-ran the whole sweep every time it
		// auto-compacted, roughly every 20 minutes, for no hygiene gain.
		// Matcher semantics, from the settings schema at
		// json.schemastore.org/claude-code-settings.json and
		// code.claude.com/docs/en/hooks#matcher-patterns: a value of only
		// letters, digits, `_`, `-`, spaces, `,` and `|` is an exact-string
		// list separated by `|` or `,`; the SessionStart matcher filters on
		// `source`, whose values are startup | resume | clear | compact | fork.
		const group = settings.hooks.SessionStart[0];
		expect(group.matcher).toBe("startup|resume");
		expect(group.matcher).toMatch(/^[A-Za-z0-9_\-, |]+$/);
		const sources = String(group.matcher).split("|");
		expect(sources).toEqual(["startup", "resume"]);
		for (const noisy of ["clear", "compact", "fork"]) {
			expect(sources).not.toContain(noisy);
		}
	});

	it("keeps SubagentStop short, because it never removes a tree", () => {
		const timeoutS = settings.hooks.SubagentStop[0].hooks[0].timeout;
		expect(timeoutS).toBeLessThanOrEqual(15);
		expect(settings.hooks.SubagentStop[0].hooks[0].command).toContain(
			"--hook subagent-stop",
		);
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 3 (F1) — the sweep must survive its own inspection
// ---------------------------------------------------------------------------

describe("worktreeActivityMs across a real `git status` (review round 3, F1)", () => {
	// The pure half of this rail is covered by worktree-hygiene.test.ts. What
	// only a REAL worktree can prove is the premise it rests on: that
	// `git status --porcelain` — the command the dirty rail runs inside the
	// tree — bumps `<admin>` and `<admin>/index` while leaving the checkout
	// directory, `<admin>/HEAD` and `<admin>/logs/HEAD` alone. Reading the
	// bumped signals collapsed every candidate to `age 0ms`, so `too-young`
	// rejected all of them and the sweep removed nothing, ever.

	let fixtureRoot = "";
	let repo = "";
	let worktree = "";
	const BACKDATE_MS = 3 * 60 * 60_000;

	const git = (args: string[], cwd: string) =>
		gitExecFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}) as string;

	function adminDirOf(worktreePath: string): string {
		const dotGit = path.join(worktreePath, ".git");
		if (fs.statSync(dotGit).isDirectory()) return dotGit;
		const match = /^gitdir:\s*(.+)$/m.exec(
			fs.readFileSync(dotGit, "utf8").trim(),
		);
		expect(match, "worktree .git file must name its admin dir").toBeTruthy();
		return path.resolve(worktreePath, (match as RegExpExecArray)[1].trim());
	}

	beforeEach(() => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-f1-"));
		repo = path.join(fixtureRoot, "repo");
		fs.mkdirSync(repo);
		git(["init", "-q", "-b", "master"], repo);
		// Identities from tests/support/git-config-guard.ts KNOWN_FIXTURE_*; a
		// literal this repo does not already register reds git-fixture-governance.
		git(["config", "user.email", "test@example.com"], repo);
		git(["config", "user.name", "pi-lens test"], repo);
		fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
		git(["add", "a.txt"], repo);
		git(["commit", "-qm", "init"], repo);
		// Shaped like a real agent worktree, so isAgentWorktreePath holds and
		// the plan below is the production one rather than a synthetic path.
		worktree = path.join(repo, ".claude", "worktrees", "agent-deadbeef");
		git(
			["worktree", "add", "-q", "-b", "worktree-agent-deadbeef", worktree],
			repo,
		);
	});

	afterEach(() => {
		try {
			git(["worktree", "remove", "--force", worktree], repo);
		} catch {
			/* an assertion already failed; cleanup is best-effort */
		}
		fs.rmSync(fixtureRoot, { recursive: true, force: true });
	});

	/**
	 * Age the worktree by BACKDATE_MS the way three hours of wall clock would:
	 * every mtime moves back, AND the reflog's recorded entry timestamps move
	 * back with them. Rewriting only mtimes would leave a reflog that still
	 * says "HEAD moved just now", which is a genuinely young tree — the rail
	 * would be right to keep it, and the test would prove nothing.
	 */
	function backdateEverySignal(nowMs: number): void {
		const admin = adminDirOf(worktree);
		const reflog = path.join(admin, "logs", "HEAD");
		if (fs.existsSync(reflog)) {
			const shifted = fs
				.readFileSync(reflog, "utf8")
				.replace(
					/(\s)(\d{9,12})(\s[+-]\d{4})/g,
					(_all, before, seconds, after) =>
						`${before}${Number(seconds) - Math.round(BACKDATE_MS / 1000)}${after}`,
				);
			fs.writeFileSync(reflog, shifted);
		}
		const past = new Date(nowMs - BACKDATE_MS);
		for (const target of [
			worktree,
			admin,
			path.join(admin, "HEAD"),
			path.join(admin, "index"),
			reflog,
		]) {
			if (fs.existsSync(target)) fs.utimesSync(target, past, past);
		}
	}

	it("still reports the tree as hours old after the dirty rail has run", () => {
		const nowMs = Date.now();
		backdateEverySignal(nowMs);

		// Exactly the call isDirty() makes, and the reason the tree looked new.
		expect(git(["status", "--porcelain"], worktree).trim()).toBe("");

		const ageMs = nowMs - worktreeActivityMs(worktree, nowMs);
		expect(
			ageMs,
			`activity read ${ageMs}ms old; the sweep's own git status reset it`,
		).toBeGreaterThan(BACKDATE_MS - 60_000);
	});

	it("plans a backdated clean, pushed tree for REMOVAL after isDirty ran", () => {
		// The acceptance shape: age measured, dirtiness measured, verdict
		// `remove`. On the pre-fix reading this tree came back `too-young`
		// with `age 0ms`.
		const nowMs = Date.now();
		backdateEverySignal(nowMs);
		const dirty = git(["status", "--porcelain"], worktree).trim() !== "";
		const mtimeMs = worktreeActivityMs(worktree, nowMs);

		const plan = planWorktreePrune({
			worktrees: [
				{
					path: worktree,
					head: "deadbeef",
					branch: "refs/heads/worktree-agent-deadbeef",
					dirty,
					pushed: true,
					mtimeMs,
					locked: false,
					lockPid: null,
				},
			] as never,
			nowMs,
			minAgeMs: DEFAULT_MIN_AGE_MS,
		});

		expect(
			plan.keep.map((k: { reason: string; detail: string | null }) => [
				k.reason,
				k.detail,
			]),
		).toEqual([]);
		expect(plan.remove.map((r: { path: string }) => r.path)).toEqual([
			worktree,
		]);
	});

	it("keeps reading a tree whose HEAD genuinely moved as recent", () => {
		// The rail must still SEE real activity, or it would reap live trees.
		const nowMs = Date.now();
		backdateEverySignal(nowMs);
		git(["checkout", "-q", "--detach"], worktree);
		expect(nowMs - worktreeActivityMs(worktree, nowMs)).toBeLessThan(60_000);
	});
});

describe("candidate enrichment order (review round 3, F1b)", () => {
	// Defense in depth for the rail above: object-literal properties evaluate
	// in source order, and the shipped version read activity AFTER running
	// `git status` inside the tree. The admissible signals now refuse that
	// write, so the order is no longer load-bearing — but a signal added to
	// the gatherer later would make it load-bearing again, silently.
	const source = fs.readFileSync(
		path.resolve(__dirname, "../../scripts/prune-agent-worktrees.mjs"),
		"utf8",
	);

	it("reads worktree activity before anything that runs git in the tree", () => {
		const activityAt = source.indexOf("worktreeActivityMs(row.path, nowMs)");
		const dirtyAt = source.indexOf("isDirty(row.path,");
		expect(
			activityAt,
			"worktreeActivityMs(row.path, …) call site",
		).toBeGreaterThan(-1);
		expect(dirtyAt, "isDirty(row.path, …) call site").toBeGreaterThan(-1);
		expect(activityAt).toBeLessThan(dirtyAt);
	});
});
