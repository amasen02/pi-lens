#!/usr/bin/env node
/**
 * scripts/prune-agent-worktrees.mjs (#2435)
 *
 * Agent worktree + orphan-process hygiene. Two independent sweeps:
 *
 *  1. WORKTREES. Every `.claude/worktrees/agent-*` git worktree that is
 *     clean, whose HEAD is contained in an `origin/*` ref, and that is old
 *     enough (or explicitly named by `--only`) is removed, together with the
 *     agent-session branch it left behind. 15 such trees accumulated on one
 *     box in a single day (#2435), each with its own build output.
 *  2. ORPHAN FIXTURES. Any `tests/fixtures/*` / `tests/support/*` helper
 *     process whose parent has exited is killed — the class that left
 *     `fake-lsp-server.mjs` running for an hour after its fixer finished and
 *     made one worktree unremovable. The fixture's own missing teardown is
 *     #2436; this is the machine-level net under it, not the fix.
 *
 * ALL the decision logic lives in scripts/lib/worktree-hygiene.mjs and is
 * pure (tables in, verdicts out). This file owns only the I/O: `git`
 * invocations, the platform process listing, `process.kill`, and the ledger
 * write. Anything that could destroy work is therefore unit-testable
 * WITHOUT this file running.
 *
 * Safety rails (see the library header for the full contract):
 *   - never a dirty tree; never an unpushed tree — no flag overrides either;
 *   - never a tree younger than --min-age, and never one whose git lock
 *     names a live pid, UNLESS --only names it;
 *   - never this process, and never any ancestor of it;
 *   - never a fixture helper whose parent is still alive, and never one whose
 *     parent pid is unreadable — unanswered is keep, not kill;
 *   - kills are always by pid after a command-line/cwd match, never
 *     `taskkill`-by-name.
 *
 * A worktree's AGE is read only from signals this sweep does not itself
 * write — see `WORKTREE_ACTIVITY_SIGNALS` in the library. Reading the git
 * index made every tree `age 0ms` the moment the dirty rail looked at it, and
 * the sweep removed nothing at all for its whole first life.
 *
 * WHO REMOVES WHAT (PR #2438 review S1 -- see resolveHookPolicy):
 *   `--hook subagent-stop` NEVER removes a worktree. Resume-by-SendMessage
 *   happens after SubagentStop, and .claude/skills/merge-train/SKILL.md keeps
 *   a fixer's worktree until its PR merges -- removing it there would break
 *   the fix round. It runs the orphan-fixture sweep SCOPED to that agent's
 *   tree, and with no usable `agent_id` it does nothing but say so.
 *   Removal belongs to `--hook session-start` (default --min-age, clean +
 *   pushed rails, never --only, at most ONE tree per run) and to a manual
 *   `npm run hygiene` (same rails, --min-age overridable, uncapped).
 *
 * Usage:
 *   node scripts/prune-agent-worktrees.mjs [--dry-run] [--min-age 30m]
 *        [--only <path>]... [--json] [--quiet]
 *   node scripts/prune-agent-worktrees.mjs --hook subagent-stop   (reads the
 *        hook JSON payload on stdin and scopes the orphan sweep by `agent_id`)
 *   node scripts/prune-agent-worktrees.mjs --hook session-start
 *
 * Exit code is ALWAYS 0. This is a hygiene sweep wired to Claude Code hooks
 * (`.claude/settings.json`); a hygiene failure must never fail a session.
 * Errors are printed and recorded in the ledger instead.
 *
 * Ledger: `<PILENS_DATA_DIR | PI_LENS_HOME | ~/.pi-lens>/hygiene.log`, JSONL,
 * bounded to the newest DEFAULT_LOG_MAX_LINES records with a truncated
 * command field (an append-only log with an unbounded field is the classic
 * "bounded on one axis, unbounded on another" leak this repo keeps finding).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_LOG_MAX_LINES,
	DEFAULT_MIN_AGE_MS,
	capRemovals,
	collectAncestorPids,
	formatKillRecord,
	formatScanRecord,
	formatWorktreeRecord,
	isAgentBranchCandidate,
	isAgentWorktreePath,
	orderBySelection,
	parseDuration,
	parseLockPid,
	parseReflogLastEntryMs,
	parseWorktreeList,
	planBranchDeletions,
	planOrphanSweep,
	planWorktreePrune,
	pruneLogLines,
	selectProcessesUnderPath,
	worktreeActivityFromSignals,
} from "./lib/worktree-hygiene.mjs";
import { snapshotProcesses } from "./lib/process-scan.mjs";

const isWindows = process.platform === "win32";

/**
 * Wall-clock budget for the whole sweep in hook mode. #2435 requires a hook
 * that finishes in under 2s with nothing to do; measured per-tree cost on
 * that box is ~130ms (`git status` 76ms + `merge-base --is-ancestor` 47ms),
 * so ~1.2s of enrichment plus a bounded process scan fits. Trees the budget
 * does not reach are reported `not-evaluated` and retried next sweep —
 * hygiene converges across sessions instead of blocking one.
 */
export const DEFAULT_HOOK_BUDGET_MS = 2_000;
/** Wall-clock budget for a manual (non-hook) invocation. */
export const DEFAULT_MANUAL_BUDGET_MS = 60_000;
/**
 * Wall-clock budget for the process-table snapshot alone. Measured on the
 * #2435 box: ~208ms `powershell.exe` startup + ~316ms for the projected WQL
 * query (the unprojected `Get-CimInstance Win32_Process` costs ~570ms, which
 * is why the query names its three columns). 1200ms leaves headroom for a
 * loaded box; on timeout the table comes back EMPTY, which degrades every
 * selector to "kill nothing".
 */
export const DEFAULT_SCAN_TIMEOUT_MS = 1_200;
/**
 * Below this much remaining budget the process scan is SKIPPED outright and
 * said so, rather than started with a stub timeout it cannot meet. An empty
 * process table silently disables both the orphan sweep and the
 * kill-what-holds-the-tree step, which is exactly the kind of invisible
 * degradation this repo's defect catalog names.
 */
export const MIN_SCAN_BUDGET_MS = 400;
/** Per-`git`-call wall-clock bound for a manual (non-hook) sweep. */
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;
/** Floor for any per-`git`-call bound; below this even a warm call fails. */
export const MIN_GIT_TIMEOUT_MS = 250;
/**
 * Bound for `git worktree remove` / `prune` — generous, and deliberately not
 * tied to the sweep budget, but a real bound: `git()` enforces it with
 * killSignal SIGKILL. Aborting a recursive delete midway is strictly worse
 * than overrunning (it leaves a half-removed tree and a stale admin
 * directory), so 60s is set far above any real removal and only ever fires on
 * a wedged git — and it sits inside the 90s SessionStart hook timeout, which
 * is sized to cover one full removal plus the sweep around it (review S8, and
 * review round 3 F7 for the comment that used to claim no bound at all).
 */
export const REMOVE_TIMEOUT_MS = 60_000;
/** Grace period between SIGTERM and the hard kill (ms). */
const KILL_GRACE_MS = 300;

const USAGE = `Usage: node scripts/prune-agent-worktrees.mjs [options]

  --dry-run             Print the plan and exit without removing or killing.
  --min-age <duration>  Minimum worktree age to be eligible (default 30m).
                        Accepts 500, 500ms, 90s, 30m, 2h.
  --budget-ms <dur>     Wall-clock budget for the whole sweep (default 2s in
                        --hook mode, 60s otherwise). Trees not reached are
                        reported "not-evaluated" and retried next sweep.
  --only <path>         Restrict the sweep to this worktree; repeatable.
                        Overrides --min-age and the live-lock rail for the
                        named tree — never the dirty/unpushed rails.
  --hook <event>        subagent-stop | session-start. Reads the hook JSON
                        payload on stdin. subagent-stop NEVER removes a
                        worktree: it reaps orphaned test-fixture helpers under
                        the tree named by the payload's agent_id, and does
                        nothing at all without one. session-start removes at
                        most ONE tree (the oldest eligible) per run.
  --no-orphan-sweep     Skip the fixture-orphan sweep.
  --json                Emit the plan as one JSON object instead of text.
  --quiet               Only print lines about work actually done.
  --help                This text.

Always exits 0.`;

// ---------------------------------------------------------------------------
// Argument parsing (pure; exported for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, minAgeMs: number, only: string[]|null, hook: string|null, orphanSweep: boolean, json: boolean, quiet: boolean, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
	const options = {
		dryRun: false,
		minAgeMs: DEFAULT_MIN_AGE_MS,
		budgetMs: null,
		only: null,
		hook: null,
		orphanSweep: true,
		json: false,
		quiet: false,
		help: false,
		errors: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--dry-run":
			case "-n":
				options.dryRun = true;
				break;
			case "--min-age": {
				const raw = argv[++i];
				const parsed = parseDuration(raw);
				if (parsed === null) {
					// Loud, never a silent fallback to 0 — a mis-typed --min-age
					// that quietly became 0 would disable the age rail entirely.
					options.errors.push(`invalid --min-age value: ${String(raw)}`);
				} else {
					options.minAgeMs = parsed;
				}
				break;
			}
			case "--budget-ms": {
				const raw = argv[++i];
				const parsed = parseDuration(raw);
				if (parsed === null || parsed === 0) {
					options.errors.push(`invalid --budget-ms value: ${String(raw)}`);
				} else {
					options.budgetMs = parsed;
				}
				break;
			}
			case "--only": {
				const raw = argv[++i];
				if (!raw) {
					options.errors.push("--only requires a path");
					break;
				}
				options.only = [...(options.only ?? []), raw];
				break;
			}
			case "--hook": {
				const raw = argv[++i];
				if (raw !== "subagent-stop" && raw !== "session-start") {
					options.errors.push(`unknown --hook event: ${String(raw)}`);
				} else {
					options.hook = raw;
				}
				break;
			}
			case "--no-orphan-sweep":
				options.orphanSweep = false;
				break;
			case "--json":
				options.json = true;
				break;
			case "--quiet":
			case "-q":
				options.quiet = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				options.errors.push(`unknown argument: ${arg}`);
		}
	}
	return options;
}

/**
 * What each invocation mode is ALLOWED to do. One table, consulted once, so
 * "SubagentStop must not remove worktrees" is a value a test can read rather
 * than a branch buried in main() (PR #2438 review S1/S8).
 *
 * `maxRemovals`: `Infinity` = uncapped (a human ran it and is watching);
 * 1 = one tree per SessionStart, because `git worktree remove` is bounded at
 * REMOVE_TIMEOUT_MS and more than one cannot fit inside the hook's own
 * timeout; 0 = never, for SubagentStop -- and since review round 3 (F4)
 * `capRemovals` reads that 0 as the zero it looks like, instead of folding it
 * into a "non-positive means uncapped" branch that said the opposite.
 */
export const HOOK_POLICIES = Object.freeze({
	"subagent-stop": Object.freeze({
		removeWorktrees: false,
		deleteBranches: false,
		orphanSweep: true,
		scopedToAgentTree: true,
		maxRemovals: 0,
	}),
	"session-start": Object.freeze({
		removeWorktrees: true,
		deleteBranches: true,
		orphanSweep: true,
		scopedToAgentTree: false,
		maxRemovals: 1,
	}),
	manual: Object.freeze({
		removeWorktrees: true,
		deleteBranches: true,
		orphanSweep: true,
		scopedToAgentTree: false,
		maxRemovals: Number.POSITIVE_INFINITY,
	}),
});

/**
 * @param {string|null|undefined} hook
 * @returns {(typeof HOOK_POLICIES)["manual"]}
 */
export function resolveHookPolicy(hook) {
	return HOOK_POLICIES[hook ?? "manual"] ?? HOOK_POLICIES.manual;
}

/**
 * Derive the worktree a SubagentStop payload refers to. Claude Code names an
 * agent worktree `.claude/worktrees/agent-<agent_id>`, so the payload's
 * `agent_id` maps to a path — but the mapping is a NAMING CONVENTION, not a
 * documented contract, so the caller must verify the derived path is a real
 * worktree before acting on it. Returns null for any payload that does not
 * carry a usable id.
 *
 * @param {unknown} payload
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function worktreePathFromHookPayload(payload, repoRoot) {
	if (!payload || typeof payload !== "object") return null;
	const agentId = /** @type {{ agent_id?: unknown }} */ (payload).agent_id;
	if (typeof agentId !== "string") return null;
	// Ids are opaque; refuse anything that could escape the worktrees dir.
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return null;
	return path.join(repoRoot, ".claude", "worktrees", `agent-${agentId}`);
}

/**
 * Read a hook's JSON payload from stdin. Never blocks on an interactive
 * terminal, and treats any read/parse failure as "no payload" rather than an
 * error — a hook that cannot identify its agent still runs the default
 * sweep.
 *
 * @returns {unknown}
 */
function readHookPayload() {
	if (process.stdin.isTTY) return null;
	try {
		const raw = fs.readFileSync(0, "utf8");
		if (!raw.trim()) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * `git` with shell:false, a bounded buffer, AND a wall-clock timeout.
 *
 * The timeout is not decoration. Measured on the #2435 box while five agents
 * were building and testing concurrently, a single `git status --porcelain`
 * took over 100 SECONDS; without a per-call bound the sweep's own budget is
 * unenforceable, because the budget can only be checked BETWEEN calls. A
 * timed-out (or failed) call returns null, which every caller reads in the
 * safe direction: "dirty" / "unpushed" / "keep".
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {string|null}
 */
function git(args, cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			shell: false,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: Math.max(MIN_GIT_TIMEOUT_MS, Math.round(timeoutMs)),
			killSignal: "SIGKILL",
		});
	} catch {
		return null;
	}
}

/**
 * The MAIN checkout's root, which is where `.claude/worktrees/` actually
 * lives. `REPO_ROOT` is derived from this script's own location, so a sweep
 * invoked from inside an agent worktree would otherwise look for
 * `<worktree>/.claude/worktrees/agent-<id>` and find nothing. Asked of git
 * rather than reconstructed by string surgery: `--git-common-dir` is the
 * shared `.git` of the whole worktree set.
 *
 * @param {number} timeoutMs
 * @returns {string|null}
 */
function mainCheckoutRoot(timeoutMs) {
	const out = git(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		REPO_ROOT,
		timeoutMs,
	);
	const commonDir = (out ?? "").trim();
	if (!commonDir) return null;
	return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
}

/**
 * Resolve a worktree's admin directory from its `.git` file (`gitdir: ...`).
 * Authoritative, unlike guessing `<common>/worktrees/<basename>`: git does
 * not guarantee the admin directory is named after the worktree.
 *
 * @param {string} worktreePath
 * @returns {string|null}
 */
function readWorktreeAdminDir(worktreePath) {
	try {
		const dotGit = path.join(worktreePath, ".git");
		const stat = fs.statSync(dotGit);
		if (stat.isDirectory()) return dotGit;
		const content = fs.readFileSync(dotGit, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/m.exec(content);
		return match ? path.resolve(worktreePath, match[1].trim()) : null;
	} catch {
		return null;
	}
}

/**
 * Newest observed activity for a worktree. `--min-age` asks "has anyone
 * touched this recently", so the only admissible answers are signals the
 * sweep's own inspection does not write -- see `WORKTREE_ACTIVITY_SIGNALS`
 * for the measured table and why `<admin>` and `<admin>/index` are banned
 * (PR #2438 review round 3, F1). Gathering happens here because it touches
 * the filesystem; the decision is the pure `worktreeActivityFromSignals`.
 *
 * Unreadable => `nowMs` => too young => kept, which is the safe direction.
 *
 * Exported for tests: the rail this feeds is the difference between a sweep
 * that removes finished trees and one that can never remove anything, and
 * proving it needs a REAL worktree that a real `git status` has run inside.
 *
 * @param {string} worktreePath
 * @param {number} nowMs
 * @returns {number}
 */
export function worktreeActivityMs(worktreePath, nowMs) {
	const mtimeOf = (file) => {
		try {
			return fs.statSync(file).mtimeMs;
		} catch {
			/* missing input just doesn't contribute */
			return null;
		}
	};
	const adminDir = readWorktreeAdminDir(worktreePath);
	/** @type {Record<string, number|null>} */
	const signals = {
		checkout: mtimeOf(worktreePath),
		head: adminDir ? mtimeOf(path.join(adminDir, "HEAD")) : null,
		reflog: adminDir
			? reflogLastEntryMs(path.join(adminDir, "logs", "HEAD"))
			: null,
	};
	return worktreeActivityFromSignals(signals, nowMs);
}

/**
 * Last entry time of a reflog file, or null when it is absent or unparseable.
 * Reads only the tail: a long-lived worktree's `logs/HEAD` is small, but a
 * bounded read keeps the sweep's per-tree cost flat regardless.
 *
 * @param {string} file
 * @returns {number|null}
 */
function reflogLastEntryMs(file) {
	try {
		return parseReflogLastEntryMs(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * True iff `sha` is contained in at least one `refs/remotes/origin/*` ref.
 * Unreadable git output => false => "unpushed" => kept. Fails safe.
 *
 * Two-step on purpose, because this is the sweep's dominant cost. Measured
 * on the #2435 box (5 worktrees, this repo):
 *   `for-each-ref --contains=<sha> refs/remotes/origin` : 640ms
 *   `merge-base --is-ancestor <sha> origin/master`      :  47ms
 * The cheap check answers the overwhelmingly common case (the tree's work
 * is already on master), and the expensive one only runs for a head that
 * is NOT on master yet — an open PR branch — which still has to be answered
 * correctly, so it is a fallback rather than a replacement.
 *
 * @param {string|null} sha
 * @param {string} repoRoot
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
function isContainedInOrigin(
	sha,
	repoRoot,
	timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
) {
	if (!sha) return false;
	// `--is-ancestor` communicates through its exit code; git() returns "" on
	// exit 0 and null on any non-zero exit.
	if (
		git(
			["merge-base", "--is-ancestor", sha, "origin/master"],
			repoRoot,
			timeoutMs,
		) !== null
	) {
		return true;
	}
	const out = git(
		[
			"for-each-ref",
			`--contains=${sha}`,
			"--count=1",
			"--format=%(refname)",
			"refs/remotes/origin",
		],
		repoRoot,
		timeoutMs,
	);
	return typeof out === "string" && out.trim() !== "";
}

/**
 * `git status --porcelain` non-empty. Unreadable => true => "dirty" => kept.
 * Fails safe in the direction that never destroys work.
 *
 * @param {string} worktreePath
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
function isDirty(worktreePath, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
	const out = git(["status", "--porcelain"], worktreePath, timeoutMs);
	if (out === null) return true;
	return out.trim() !== "";
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------
//
// The listing itself lives in scripts/lib/process-scan.mjs (review round 3,
// F2): this script and scripts/compat-smoke-behavioral.mjs each carried a
// windowsExe + snapshotProcesses pair differing only in the columns they
// asked for, so the exit-code hardening from review S5 landed in one and not
// the other. This file now asks for the projection it needs and nothing else.

/**
 * Best-effort cwd enrichment on procfs platforms (Linux). A process holding
 * a worktree open by cwd alone shows nothing useful in its command line, and
 * `/proc/<pid>/cwd` is the only portable-ish way to see it. Absent on
 * Windows and macOS, where command-line matching is the sole signal — stated
 * rather than silently assumed.
 *
 * @param {import("./lib/worktree-hygiene.mjs").ProcRow[]} rows
 * @returns {import("./lib/worktree-hygiene.mjs").ProcRow[]}
 */
function enrichCwd(rows) {
	if (isWindows || !fs.existsSync("/proc")) return rows;
	for (const row of rows) {
		try {
			row.cwd = fs.readlinkSync(`/proc/${row.pid}/cwd`);
		} catch {
			/* exited, or not ours to read */
		}
	}
	return rows;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but is not ours to signal (observed on
		// Windows for protected processes) — alive.
		return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
	}
}

/**
 * Terminate one pid: SIGTERM, a short grace period, then SIGKILL if it is
 * still there. Deliberately `process.kill` by pid and never `taskkill` —
 * `taskkill /IM node.exe` would take out every unrelated node process on the
 * box, and this repo has already been burned by teardown-time spawns on
 * Windows (#234), so no child process is spawned to do the killing either.
 *
 * @param {number} pid
 * @returns {Promise<{ killed: boolean, error: string|null }>}
 */
async function terminatePid(pid) {
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ESRCH") return { killed: true, error: null };
		return { killed: false, error: String(code ?? err) };
	}
	await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
	if (!isPidAlive(pid)) return { killed: true, error: null };
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ESRCH") return { killed: true, error: null };
		return { killed: false, error: String(code ?? err) };
	}
	return { killed: !isPidAlive(pid), error: null };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Where the hygiene ledger lives. `PILENS_DATA_DIR` is honored first because
 * #2435 names it, then `PI_LENS_HOME` (the machine-scoped root the sibling
 * test-suite lock already uses — this sweep is machine-scoped, not
 * project-scoped), then `~/.pi-lens`.
 *
 * @returns {string}
 */
export function getHygieneLogPath() {
	const dataDir = process.env.PILENS_DATA_DIR?.trim();
	const home = process.env.PI_LENS_HOME?.trim();
	const base = dataDir
		? path.resolve(dataDir)
		: home
			? path.resolve(home)
			: path.join(os.homedir(), ".pi-lens");
	return path.join(base, "hygiene.log");
}

/**
 * Append records, then truncate to the newest DEFAULT_LOG_MAX_LINES. Best
 * effort: a ledger that cannot be written must never fail the sweep it is
 * recording.
 *
 * @param {string[]} records
 */
function appendLedger(records) {
	if (records.length === 0) return;
	const logPath = getHygieneLogPath();
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		let existing = [];
		try {
			existing = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
		} catch {
			/* first write */
		}
		const kept = pruneLogLines(existing, records, DEFAULT_LOG_MAX_LINES);
		fs.writeFileSync(logPath, `${kept.join("\n")}\n`, "utf8");
	} catch (error) {
		console.error(
			`[hygiene] could not write ${logPath}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove top-level directory SYMLINKS/JUNCTIONS from a worktree before git
 * deletes it. Agents junction `node_modules` into the main checkout to avoid
 * a per-worktree install; a recursive delete that followed that reparse
 * point would wipe the SHARED node_modules. `fs.rmSync` on the link itself
 * (never `{ recursive: true }`) unlinks the junction and leaves its target
 * untouched. Depth 1 only — a link nested deeper is not a shape this repo
 * creates, and walking the whole tree to find one would cost more than the
 * removal it precedes.
 *
 * @param {string} worktreePath
 * @returns {string[]} paths of unlinked reparse points
 */
function unlinkTopLevelLinks(worktreePath) {
	const unlinked = [];
	let entries;
	try {
		entries = fs.readdirSync(worktreePath, { withFileTypes: true });
	} catch {
		return unlinked;
	}
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		const full = path.join(worktreePath, entry.name);
		try {
			fs.rmSync(full, { recursive: false, force: true });
			unlinked.push(full);
		} catch {
			try {
				fs.rmdirSync(full);
				unlinked.push(full);
			} catch {
				/* leave it; git will complain and we log the failure */
			}
		}
	}
	return unlinked;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SELF_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SELF_FILE);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * Take the bounded process snapshot, enrich it with cwd where the platform
 * allows, and report whether the LISTING itself succeeded. Any degradation is
 * returned as a ledger record rather than only printed: the hooks run
 * `--quiet`, so an unrecorded degradation makes a sweep that ran blind look
 * exactly like a sweep that found nothing (defect shape 10).
 *
 * @param {{ budgetMs: number, budgetLeft: () => number }} options
 */
async function readProcessTable({ budgetMs, budgetLeft }) {
	const scanBudgetMs = Math.min(DEFAULT_SCAN_TIMEOUT_MS, budgetLeft());
	// Skipping loudly beats scanning with a stub timeout it cannot meet.
	if (scanBudgetMs < MIN_SCAN_BUDGET_MS) {
		console.error(
			`[hygiene] process scan skipped: only ${budgetLeft()}ms of the ` +
				`${budgetMs}ms budget left (needs ${MIN_SCAN_BUDGET_MS}ms); ` +
				`no orphan sweep this run`,
		);
		return {
			table: [],
			listingOk: false,
			scanBudgetMs,
			records: [
				formatScanRecord({
					reason: "skipped",
					budgetMs,
					remainingMs: budgetLeft(),
					rows: 0,
				}),
			],
		};
	}
	// The sweep needs the parent pid (the orphan predicate) and the command
	// line (both the fixture matcher and the occupant matcher).
	const { rows, ok } = await snapshotProcesses(
		["pid", "ppid", "command"],
		scanBudgetMs,
	);
	const table = enrichCwd(rows);
	const records = [];
	if (!ok) {
		console.error(
			`[hygiene] process listing failed, timed out or exited non-zero ` +
				`within ${scanBudgetMs}ms; no orphan sweep this run`,
		);
		records.push(
			formatScanRecord({
				reason: "listing-failed",
				budgetMs,
				remainingMs: scanBudgetMs,
				rows: table.length,
			}),
		);
	} else if (table.length === 0) {
		console.error(
			`[hygiene] process scan returned no rows within ${scanBudgetMs}ms; ` +
				`no orphan sweep this run`,
		);
		records.push(
			formatScanRecord({
				reason: "empty",
				budgetMs,
				remainingMs: scanBudgetMs,
				rows: 0,
			}),
		);
	}
	return { table, listingOk: ok, scanBudgetMs, records };
}

/**
 * The SubagentStop hook: reap this agent's own orphaned fixture helpers, and
 * NOTHING else. It never removes a worktree (see the file header / review S1)
 * and never touches a sibling agent's tree.
 *
 * @param {{ options: ReturnType<typeof parseArgs>, worktreePath: string, budgetMs: number, budgetLeft: () => number, say: (m: string) => void, startedAt: number, nowIso: string }} context
 */
async function runScopedOrphanSweep({
	options,
	worktreePath,
	budgetMs,
	budgetLeft,
	say,
	startedAt,
	nowIso,
}) {
	const scan = await readProcessTable({ budgetMs, budgetLeft });
	const records = [...scan.records];
	const protectedPids = collectAncestorPids(scan.table, process.pid);
	protectedPids.add(process.pid);

	const { orphans, degraded } = planOrphanSweep({
		rows: scan.table,
		selfPid: process.pid,
		protectedPids,
		restrictToPath: worktreePath,
		listingOk: scan.listingOk,
		isPidAlive,
	});
	// "listing-failed" and the empty case were already reported by
	// readProcessTable; a TRUNCATED listing is a distinct degradation and is
	// reported here.
	if (degraded && degraded.reason !== "listing-failed") {
		console.error(
			`[hygiene] process snapshot could not be verified ` +
				`(${degraded.reason}); no orphan sweep this run`,
		);
		records.push(
			formatScanRecord({
				reason: degraded.reason,
				budgetMs,
				remainingMs: scan.scanBudgetMs,
				rows: scan.table.length,
			}),
		);
	}

	for (const { row, reason } of orphans) {
		say(
			`${options.dryRun ? "WOULD KILL  " : "kill    "} pid ${row.pid}  ${reason}  ${row.command}`,
		);
	}
	for (const { row, reason } of orphans) {
		if (options.dryRun) {
			records.push(
				formatKillRecord({
					pid: row.pid,
					command: row.command,
					reason,
					worktree: worktreePath,
					dryRun: true,
					nowIso,
				}),
			);
			continue;
		}
		const { killed, error } = await terminatePid(row.pid);
		records.push(
			formatKillRecord({
				pid: row.pid,
				command: row.command,
				reason,
				worktree: worktreePath,
				killed,
				error,
				nowIso,
			}),
		);
	}
	appendLedger(records);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					hook: "subagent-stop",
					worktree: worktreePath,
					dryRun: options.dryRun,
					remove: [],
					keep: [],
					orphans: orphans.map(({ row, reason }) => ({
						pid: row.pid,
						ppid: row.ppid,
						reason,
						command: row.command,
					})),
					processTableRows: scan.table.length,
				},
				null,
				2,
			),
		);
	} else {
		say(
			`${options.dryRun ? "dry-run: " : ""}subagent-stop: ` +
				`${orphans.length} orphan process(es) under ${worktreePath} ` +
				`(worktrees are never removed here), ` +
				`${scan.table.length} process rows, ${Date.now() - startedAt}ms`,
		);
	}
}

async function main(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return;
	}
	for (const error of options.errors) console.error(`[hygiene] ${error}`);
	if (options.errors.length > 0) return;

	const startedAt = Date.now();
	const nowIso = new Date().toISOString();
	const say = (message) => {
		if (!options.quiet && !options.json) console.log(`[hygiene] ${message}`);
	};
	const policy = resolveHookPolicy(options.hook);
	const budgetMs =
		options.budgetMs ??
		(options.hook ? DEFAULT_HOOK_BUDGET_MS : DEFAULT_MANUAL_BUDGET_MS);
	const budgetLeft = () => Math.max(0, budgetMs - (Date.now() - startedAt));

	if (policy.scopedToAgentTree) {
		const worktreesBase =
			mainCheckoutRoot(
				Math.min(
					DEFAULT_GIT_TIMEOUT_MS,
					Math.max(MIN_GIT_TIMEOUT_MS, budgetLeft()),
				),
			) ?? REPO_ROOT;
		const derived = worktreePathFromHookPayload(
			readHookPayload(),
			worktreesBase,
		);
		if (!derived || !fs.existsSync(derived)) {
			// Deliberately does NOT fall back to the ordinary sweep: this hook
			// has a mandate over exactly one agent's tree, and with no usable
			// agent_id it has no mandate at all.
			console.error(
				"[hygiene] subagent-stop: no usable agent_id on stdin; nothing to do",
			);
			return;
		}
		await runScopedOrphanSweep({
			options,
			worktreePath: derived,
			budgetMs,
			budgetLeft,
			say,
			startedAt,
			nowIso,
		});
		return;
	}

	if (options.hook === "session-start") {
		readHookPayload();
		if (options.only) {
			console.error(
				"[hygiene] session-start: ignoring --only; the session sweep never " +
					"narrows to a single tree",
			);
		}
	}
	// `--only` belongs to a human at a terminal. The session sweep runs the
	// ordinary rails over every tree (review S1).
	const only = options.hook === "session-start" ? null : options.only;
	const minAgeMs = options.minAgeMs;

	// Every git call is bounded by whatever is LEFT of the sweep's budget, not
	// by a fixed constant: the budget is only enforceable if no single call can
	// outlast it (a `git status` on this box hit 100s+ under five-agent load).
	const boundedTo = (remainingMs) =>
		Math.min(DEFAULT_GIT_TIMEOUT_MS, Math.max(MIN_GIT_TIMEOUT_MS, remainingMs));
	const gitBudget = () => boundedTo(budgetLeft());
	// Reserve room for the process snapshot so a long enrichment pass cannot
	// starve the orphan sweep entirely: reading the worktree table and every
	// per-tree query is bounded by the ENRICH deadline, not the total budget.
	const enrichDeadline =
		startedAt + Math.max(0, budgetMs - DEFAULT_SCAN_TIMEOUT_MS);
	const enrichBudget = () => boundedTo(enrichDeadline - Date.now());

	const porcelain = git(
		["worktree", "list", "--porcelain"],
		REPO_ROOT,
		enrichBudget(),
	);
	if (porcelain === null) {
		console.error("[hygiene] `git worktree list` failed; nothing to do");
		return;
	}
	const listed = parseWorktreeList(porcelain);
	const nowMs = Date.now();

	// Trees named by --only are inspected FIRST, so a narrowed manual run never
	// loses its budget to unrelated siblings (orderBySelection, tested).
	const ordered = orderBySelection(listed, only);

	let evaluated = 0;
	let skippedForBudget = 0;
	const candidates = ordered.map((row) => {
		if (!isAgentWorktreePath(row.path)) {
			return { ...row, dirty: false, pushed: false, mtimeMs: nowMs };
		}
		// `evaluated === 0` guarantees at least one tree is always inspected,
		// so a pathologically tight budget degrades to slow progress rather
		// than to a sweep that can never remove anything.
		if (evaluated > 0 && Date.now() > enrichDeadline) {
			skippedForBudget++;
			return {
				path: row.path,
				head: row.head,
				branch: row.branch,
				locked: row.locked,
				lockPid: parseLockPid(row.lockedReason),
				unevaluated: true,
				dirty: true,
				pushed: false,
				mtimeMs: nowMs,
			};
		}
		evaluated++;
		// Activity is READ BEFORE anything that runs git inside the tree
		// (F1b). `worktreeActivityFromSignals` already refuses the signals
		// `git status` writes, so this ordering is belt-and-braces rather than
		// the fix -- but object-literal properties evaluate in source order,
		// and the version that read activity LAST is precisely how a sweep
		// that removes nothing shipped. Reading first means no future signal
		// added to the gatherer can quietly re-open the hole.
		const mtimeMs = worktreeActivityMs(row.path, nowMs);
		return {
			path: row.path,
			head: row.head,
			branch: row.branch,
			locked: row.locked,
			lockPid: parseLockPid(row.lockedReason),
			mtimeMs,
			dirty: isDirty(row.path, enrichBudget()),
			pushed: isContainedInOrigin(row.head, REPO_ROOT, enrichBudget()),
		};
	});

	const plan = planWorktreePrune({
		worktrees: candidates,
		nowMs,
		minAgeMs,
		only,
		// Both spellings of "where this sweep lives": its own file, and the
		// directory it was invoked from. planWorktreePrune maps each to the
		// agent worktree that CONTAINS it (review S4) — neither is ever a
		// worktree root, so equality never fired.
		selfPath: [SCRIPT_DIR, process.cwd()],
		isPidAlive,
	});

	// At most one removal per SessionStart run: `git worktree remove` is
	// bounded at REMOVE_TIMEOUT_MS and a SIGKILLed removal leaves a
	// half-removed tree, so the hook's timeout has to cover the removal it
	// starts (review S8). A manual run is uncapped.
	const removals = policy.removeWorktrees
		? capRemovals(plan.remove, policy.maxRemovals)
		: [];
	const removalKeys = new Set(removals.map((removal) => removal.path));
	const deferred = plan.remove.filter(
		(removal) => !removalKeys.has(removal.path),
	);

	const wantProcessScan =
		removals.length > 0 || (options.orphanSweep && policy.orphanSweep);
	const scan = wantProcessScan
		? await readProcessTable({ budgetMs, budgetLeft })
		: { table: [], listingOk: false, scanBudgetMs: 0, records: [] };
	const degradations = [...scan.records];
	const table = scan.table;

	const protectedPids = collectAncestorPids(table, process.pid);
	protectedPids.add(process.pid);

	const orphanPlan =
		options.orphanSweep && policy.orphanSweep
			? planOrphanSweep({
					rows: table,
					selfPid: process.pid,
					protectedPids,
					listingOk: scan.listingOk,
					isPidAlive,
				})
			: { orphans: [], degraded: null };
	const orphans = orphanPlan.orphans;
	if (orphanPlan.degraded && orphanPlan.degraded.reason !== "listing-failed") {
		console.error(
			`[hygiene] process snapshot could not be verified ` +
				`(${orphanPlan.degraded.reason}); no orphan sweep this run`,
		);
		degradations.push(
			formatScanRecord({
				reason: orphanPlan.degraded.reason,
				budgetMs,
				remainingMs: scan.scanBudgetMs,
				rows: table.length,
			}),
		);
	}

	const perTreeProcesses = new Map();
	for (const removal of removals) {
		perTreeProcesses.set(
			removal.path,
			selectProcessesUnderPath(table, removal.path, { protectedPids }),
		);
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					dryRun: options.dryRun,
					minAgeMs,
					only,
					remove: removals.map((removal) => ({
						...removal,
						processes: (perTreeProcesses.get(removal.path) ?? []).map(
							(row) => ({ pid: row.pid, command: row.command }),
						),
					})),
					deferred: deferred.map((removal) => removal.path),
					keep: plan.keep,
					orphans: orphans.map(({ row, reason }) => ({
						pid: row.pid,
						ppid: row.ppid,
						reason,
						command: row.command,
					})),
					processTableRows: table.length,
				},
				null,
				2,
			),
		);
	} else {
		for (const entry of plan.keep) {
			if (entry.reason === "not-agent-worktree") continue;
			say(
				`keep    ${entry.path}  (${entry.reason}${entry.detail ? `: ${entry.detail}` : ""})`,
			);
		}
		for (const removal of deferred) {
			say(
				`defer   ${removal.path}  (removal cap ${policy.maxRemovals} per run; ` +
					`the next sweep takes it)`,
			);
		}
		for (const removal of removals) {
			const procs = perTreeProcesses.get(removal.path) ?? [];
			say(
				`${options.dryRun ? "WOULD REMOVE" : "remove "} ${removal.path}` +
					`  (age ${Math.round(removal.ageMs / 60_000)}m, branch ${removal.branch ?? "-"}` +
					`${procs.length > 0 ? `, ${procs.length} process(es) to kill` : ""})`,
			);
			for (const row of procs) say(`    pid ${row.pid}  ${row.command}`);
		}
		for (const { row, reason } of orphans) {
			say(
				`${options.dryRun ? "WOULD KILL  " : "kill    "} pid ${row.pid}  ${reason}  ${row.command}`,
			);
		}
	}

	const records = [...degradations];
	/** Full refs of the worktrees this run actually removed (review S10). */
	const removedBranchRefs = [];

	if (!options.dryRun) {
		for (const removal of removals) {
			for (const row of perTreeProcesses.get(removal.path) ?? []) {
				const { killed, error } = await terminatePid(row.pid);
				records.push(
					formatKillRecord({
						pid: row.pid,
						command: row.command,
						reason: "process holding a removable agent worktree",
						worktree: removal.path,
						killed,
						error,
						nowIso,
					}),
				);
			}
			const unlinked = unlinkTopLevelLinks(removal.path);
			for (const link of unlinked) say(`    unlinked reparse point ${link}`);
			// A locked worktree needs --force twice; passing it unconditionally
			// is harmless for the unlocked case.
			// Outside the SWEEP budget, but not unbounded: `git()` applies
			// REMOVE_TIMEOUT_MS (60s) with killSignal SIGKILL, so a wedged
			// removal is eventually killed rather than hanging the hook
			// forever (review round 3, F7 — the comment here used to claim
			// otherwise). The tradeoff that 60s buys, inside the 90s
			// SessionStart hook timeout: SIGKILLing git partway through a
			// recursive delete leaves a half-removed worktree plus a stale
			// admin directory, so the bound is set generously enough that a
			// normal removal never reaches it, and the hook timeout is sized
			// to cover one full 60s removal with 30s to spare (review S8).
			// The sweep's own enrichment budget gates whether a removal
			// STARTS, never how long it may take once it has.
			const removed = git(
				["worktree", "remove", "--force", "--force", removal.path],
				REPO_ROOT,
				REMOVE_TIMEOUT_MS,
			);
			if (removed === null) {
				console.error(`[hygiene] could not remove ${removal.path}`);
			} else if (removal.branch) {
				removedBranchRefs.push(removal.branch);
			}
			records.push(
				formatWorktreeRecord({
					path: removal.path,
					branch: removal.branch,
					ageMs: removal.ageMs,
					removed: removed !== null,
					error: removed === null ? "git worktree remove failed" : null,
					nowIso,
				}),
			);
		}
		if (removals.length > 0)
			git(["worktree", "prune"], REPO_ROOT, REMOVE_TIMEOUT_MS);

		for (const { row, reason } of orphans) {
			const { killed, error } = await terminatePid(row.pid);
			records.push(
				formatKillRecord({
					pid: row.pid,
					command: row.command,
					reason,
					worktree: null,
					killed,
					error,
					nowIso,
				}),
			);
		}

		// Only after a removal, and only for the branch that removal orphaned
		// (review S10). A sweep that removed nothing deletes nothing.
		if (policy.deleteBranches && removedBranchRefs.length > 0) {
			for (const branch of deleteStaleBranches(gitBudget, removedBranchRefs)) {
				say(`deleted branch ${branch}`);
			}
		}
	} else {
		for (const removal of removals) {
			for (const row of perTreeProcesses.get(removal.path) ?? []) {
				records.push(
					formatKillRecord({
						pid: row.pid,
						command: row.command,
						reason: "process holding a removable agent worktree",
						worktree: removal.path,
						dryRun: true,
						nowIso,
					}),
				);
			}
			records.push(
				formatWorktreeRecord({
					path: removal.path,
					branch: removal.branch,
					ageMs: removal.ageMs,
					dryRun: true,
					nowIso,
				}),
			);
		}
		for (const { row, reason } of orphans) {
			records.push(
				formatKillRecord({
					pid: row.pid,
					command: row.command,
					reason,
					dryRun: true,
					nowIso,
				}),
			);
		}
	}

	appendLedger(records);

	if (!options.json) {
		say(
			`${options.dryRun ? "dry-run: " : ""}${removals.length} worktree(s), ` +
				`${orphans.length} orphan process(es)` +
				`${deferred.length > 0 ? `, ${deferred.length} deferred to the next sweep` : ""}` +
				`${skippedForBudget > 0 ? `, ${skippedForBudget} not evaluated (budget ${budgetMs}ms)` : ""}` +
				`, ${table.length} process rows, ${Date.now() - startedAt}ms`,
		);
	}
}

/**
 * Delete the agent-session branches left behind by the worktrees this run
 * just removed. Runs after removal so `checkedOut` reflects the post-removal
 * reality, and is never called with an empty `removedBranchRefs` — the whole
 * candidate set is scoped to those refs (review S10), so a sweep can no
 * longer reach a live agent's branch just because its shape matches.
 *
 * @param {() => number} gitBudget
 * @param {string[]} removedBranchRefs
 * @returns {string[]}
 */
function deleteStaleBranches(gitBudget, removedBranchRefs) {
	const out = git(
		[
			"for-each-ref",
			"--format=%(refname:short)\t%(upstream)\t%(upstream:track)",
			"refs/heads",
		],
		REPO_ROOT,
		gitBudget(),
	);
	if (out === null) return [];
	const checkedOut = new Set(
		parseWorktreeList(
			git(["worktree", "list", "--porcelain"], REPO_ROOT, gitBudget()) ?? "",
		)
			.map((row) => row.branch)
			.filter(Boolean)
			.map((ref) => String(ref).replace(/^refs\/heads\//, "")),
	);
	const wanted = new Set(
		removedBranchRefs
			.filter((ref) => typeof ref === "string" && ref !== "")
			.map((ref) => ref.replace(/^refs\/heads\//, "")),
	);
	// Three passes on purpose: scope to the branches this run orphaned, then
	// the cheap shape/upstream/checked-out filter (one for-each-ref line each,
	// no subprocess), then the containment revwalk ONLY for survivors.
	const candidates = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [name, upstream, track] = line.split("\t");
		if (!name || !wanted.has(name)) continue;
		const branch = {
			name,
			hasUpstream: Boolean(upstream),
			upstreamGone: (track ?? "").includes("gone"),
			checkedOut: checkedOut.has(name),
		};
		if (isAgentBranchCandidate(branch)) candidates.push(branch);
	}
	const branches = candidates.map((branch) => ({
		...branch,
		containedInOrigin: isContainedInOrigin(branch.name, REPO_ROOT, gitBudget()),
	}));
	const deleted = [];
	for (const name of planBranchDeletions({ branches, removedBranchRefs })) {
		if (git(["branch", "-D", name], REPO_ROOT, gitBudget()) !== null) {
			deleted.push(name);
		}
	}
	return deleted;
}

// Only run the CLI when this file is the entry point — not when a test
// imports parseArgs/worktreeActivityMs. Mirrors with-test-lock.mjs's own
// isEntryPoint, win32 case-insensitive fallback included (a differently-cased
// invocation path still resolves to this file on NTFS).
function isEntryPoint() {
	if (!process.argv[1]) return false;
	const invoked = path.resolve(process.argv[1]);
	if (invoked === SELF_FILE) return true;
	if (!isWindows) return false;
	return invoked.toLowerCase() === SELF_FILE.toLowerCase();
}

if (isEntryPoint()) {
	main(process.argv.slice(2))
		.catch((error) => {
			// Exit code stays 0 on purpose: this runs from Claude Code hooks,
			// and a hygiene failure must never fail a session.
			console.error(
				`[hygiene] ${error instanceof Error ? (error.stack ?? error.message) : error}`,
			);
		})
		.finally(() => {
			process.exitCode = 0;
		});
}
