/**
 * Tests for the CLI seams of scripts/prune-agent-worktrees.mjs (#2435).
 *
 * The destructive logic lives in scripts/lib/worktree-hygiene.mjs and is
 * covered by worktree-hygiene.test.ts. What is left here is the surface that
 * decides HOW that logic is invoked — argument parsing, the SubagentStop
 * payload mapping, the platform process-table parsers, and the ledger
 * location. Importing the module runs no sweep: its `isEntryPoint()` guard
 * is false under vitest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_HOOK_BUDGET_MS,
	DEFAULT_MANUAL_BUDGET_MS,
	getHygieneLogPath,
	parseArgs,
	parseProcessTable,
	worktreePathFromHookPayload,
} from "../../scripts/prune-agent-worktrees.mjs";
import { DEFAULT_MIN_AGE_MS } from "../../scripts/lib/worktree-hygiene.mjs";

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

describe("parseProcessTable", () => {
	it("parses the Windows CIM tab-joined layout, command lines with tabs included", () => {
		const rows = parseProcessTable(
			[
				"1234\t5678\tnode C:\\repo\\tests\\fixtures\\fake-lsp-server.mjs",
				"4\t0\tSystem",
				"", // trailing blank line
			].join("\n"),
			true,
		);
		expect(rows).toEqual([
			{
				pid: 1234,
				ppid: 5678,
				command: "node C:\\repo\\tests\\fixtures\\fake-lsp-server.mjs",
			},
			{ pid: 4, ppid: 0, command: "System" },
		]);
	});

	it("parses the POSIX `ps -eo pid,ppid,args` layout, keeping spaces in args", () => {
		const rows = parseProcessTable(
			[
				"  1234  5678 node /repo/tests/fixtures/fake-lsp-server.mjs --port 0",
			].join("\n"),
			false,
		);
		expect(rows).toEqual([
			{
				pid: 1234,
				ppid: 5678,
				command: "node /repo/tests/fixtures/fake-lsp-server.mjs --port 0",
			},
		]);
	});

	it("drops unparseable lines rather than inventing pid 0 or NaN", () => {
		// A row with a bogus pid that survived here would be handed to
		// process.kill.
		expect(parseProcessTable("header line\n\nnot-a-pid\tx\ty", true)).toEqual(
			[],
		);
		expect(parseProcessTable("", true)).toEqual([]);
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
