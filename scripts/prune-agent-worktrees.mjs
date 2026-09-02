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
 *   - never a fixture helper whose parent is still alive;
 *   - kills are always by pid after a command-line/cwd match, never
 *     `taskkill`-by-name.
 *
 * Usage:
 *   node scripts/prune-agent-worktrees.mjs [--dry-run] [--min-age 30m]
 *        [--only <path>]... [--json] [--quiet]
 *   node scripts/prune-agent-worktrees.mjs --hook subagent-stop   (reads the
 *        hook JSON payload on stdin and derives --only from `agent_id`)
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

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_LOG_MAX_LINES,
	DEFAULT_MIN_AGE_MS,
	collectAncestorPids,
	formatKillRecord,
	formatScanRecord,
	formatWorktreeRecord,
	isAgentBranchCandidate,
	isAgentWorktreePath,
	orderBySelection,
	parseDuration,
	parseLockPid,
	parseWorktreeList,
	planWorktreePrune,
	pruneLogLines,
	selectOrphanFixtureProcesses,
	selectProcessesUnderPath,
	selectStaleBranches,
} from "./lib/worktree-hygiene.mjs";

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
 * Bound for `git worktree remove` / `prune` — generous and NOT tied to the
 * sweep budget. Aborting a recursive delete midway is strictly worse than
 * overrunning: it leaves a half-removed tree and a stale admin directory.
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
                        payload on stdin; subagent-stop derives --only from
                        the payload's agent_id when that worktree exists.
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
 * Newest observed activity for a worktree. `--min-age` is about "has anyone
 * touched this recently", so this takes the max of the checkout directory's
 * own mtime and the git admin directory's HEAD mtime (which moves on every
 * checkout/commit/reset even when the top-level directory listing does not).
 * Unreadable => 0 => "infinitely old" is WRONG for a safety rail, so an
 * unreadable tree reports `now` instead: too young, therefore kept.
 *
 * @param {string} worktreePath
 * @param {number} nowMs
 * @returns {number}
 */
function worktreeActivityMs(worktreePath, nowMs) {
	let newest = 0;
	const consider = (file) => {
		try {
			newest = Math.max(newest, fs.statSync(file).mtimeMs);
		} catch {
			/* missing input just doesn't contribute */
		}
	};
	consider(worktreePath);
	const adminDir = readWorktreeAdminDir(worktreePath);
	if (adminDir) {
		consider(adminDir);
		consider(path.join(adminDir, "HEAD"));
		consider(path.join(adminDir, "index"));
	}
	return newest === 0 ? nowMs : newest;
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

function windowsExe(name) {
	return path.join(
		process.env.SystemRoot ?? path.join("C:", "Windows"),
		"System32",
		name,
	);
}

/**
 * Snapshot the process table as `{ pid, ppid, command, cwd? }` rows.
 *
 * Windows uses `Get-CimInstance` through `powershell -NoProfile` with an
 * explicit WQL projection (measured ~316ms for the query vs ~570ms for the
 * unprojected form on the #2435 box, plus ~208ms powershell startup) —
 * `tasklist` exposes no parent pid and no command line, and `wmic` is gone
 * from Windows 11. POSIX uses `ps -eo pid,ppid,args`.
 *
 * Never rejects: a scan that fails or times out yields an EMPTY table, which
 * degrades every downstream selector to "kill nothing". Bounded by
 * `timeoutMs` so a hook can never hang a session on a wedged WMI service.
 *
 * @param {number} timeoutMs
 * @returns {Promise<import("./lib/worktree-hygiene.mjs").ProcRow[]>}
 */
function snapshotProcesses(timeoutMs) {
	const command = isWindows
		? windowsExe("WindowsPowerShell\\v1.0\\powershell.exe")
		: "ps";
	const args = isWindows
		? [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				'Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process" ' +
					'| ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
			]
		: ["-eo", "pid=,ppid=,args="];

	return new Promise((resolve) => {
		let settled = false;
		const finish = (rows) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(rows);
		};
		let child;
		const timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
			finish([]);
		}, timeoutMs);
		try {
			child = spawn(command, args, {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish([]);
			return;
		}
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
		});
		child.once("error", () => finish([]));
		child.once("close", () => finish(parseProcessTable(out, isWindows)));
	});
}

/**
 * Parse the platform listing into rows. Exported so the two column layouts
 * can be pinned by a test without spawning anything.
 *
 * @param {string} out
 * @param {boolean} tabSeparated Windows CIM emits tab-joined fields; `ps`
 *   emits whitespace-aligned columns whose third field (args) contains
 *   spaces.
 * @returns {import("./lib/worktree-hygiene.mjs").ProcRow[]}
 */
export function parseProcessTable(out, tabSeparated) {
	const rows = [];
	for (const line of String(out ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let pidText;
		let ppidText;
		let command;
		if (tabSeparated) {
			const parts = line.split("\t");
			if (parts.length < 2) continue;
			[pidText, ppidText] = parts;
			command = parts.slice(2).join("\t");
		} else {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (!match) continue;
			[, pidText, ppidText, command] = match;
		}
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		rows.push({
			pid,
			ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
			command: command ?? "",
		});
	}
	return rows;
}

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

async function main(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return;
	}
	for (const error of options.errors) console.error(`[hygiene] ${error}`);
	if (options.errors.length > 0) return;

	const startedAt = Date.now();
	const say = (message) => {
		if (!options.quiet && !options.json) console.log(`[hygiene] ${message}`);
	};

	let only = options.only;
	let minAgeMs = options.minAgeMs;

	if (options.hook === "subagent-stop") {
		const derived = worktreePathFromHookPayload(readHookPayload(), REPO_ROOT);
		if (derived && fs.existsSync(derived)) {
			only = [derived];
			minAgeMs = 0;
		}
		// No usable agent_id (or the derived tree is already gone): fall
		// through to the default sweep rather than guessing.
	} else if (options.hook === "session-start") {
		readHookPayload();
	}

	const budgetMs =
		options.budgetMs ??
		(options.hook ? DEFAULT_HOOK_BUDGET_MS : DEFAULT_MANUAL_BUDGET_MS);
	const budgetLeft = () => Math.max(0, budgetMs - (Date.now() - startedAt));
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

	// Trees named by --only are inspected FIRST, so a SubagentStop hook never
	// loses its 2s budget to unrelated siblings (orderBySelection, tested).
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
		return {
			path: row.path,
			head: row.head,
			branch: row.branch,
			locked: row.locked,
			lockPid: parseLockPid(row.lockedReason),
			dirty: isDirty(row.path, enrichBudget()),
			pushed: isContainedInOrigin(row.head, REPO_ROOT, enrichBudget()),
			mtimeMs: worktreeActivityMs(row.path, nowMs),
		};
	});

	const plan = planWorktreePrune({
		worktrees: candidates,
		nowMs,
		minAgeMs,
		only,
		// Both spellings of "where this sweep lives": its own file, and the
		// directory it was invoked from. Either may sit in a worktree.
		selfPath: [SCRIPT_DIR, process.cwd()],
		isPidAlive,
	});

	const wantProcessScan = plan.remove.length > 0 || options.orphanSweep;
	// Skipping loudly beats scanning with a stub timeout: an empty process
	// table silently disables BOTH the orphan sweep and the
	// kill-what-holds-the-tree step, and a silent no-op is the failure mode
	// this repo's defect catalog keeps flagging.
	const scanBudgetMs = Math.min(DEFAULT_SCAN_TIMEOUT_MS, budgetLeft());
	const scanSkipped = wantProcessScan && scanBudgetMs < MIN_SCAN_BUDGET_MS;
	const table =
		wantProcessScan && !scanSkipped
			? enrichCwd(await snapshotProcesses(scanBudgetMs))
			: [];
	/** @type {string[]} */
	const degradations = [];
	if (scanSkipped) {
		console.error(
			`[hygiene] process scan skipped: only ${budgetLeft()}ms of the ` +
				`${budgetMs}ms budget left (needs ${MIN_SCAN_BUDGET_MS}ms); ` +
				`no orphan sweep this run`,
		);
		degradations.push(
			formatScanRecord({
				reason: "skipped",
				budgetMs,
				remainingMs: budgetLeft(),
				rows: 0,
			}),
		);
	} else if (wantProcessScan && table.length === 0) {
		console.error(
			`[hygiene] process scan returned no rows within ${scanBudgetMs}ms; ` +
				`no orphan sweep this run`,
		);
		degradations.push(
			formatScanRecord({
				reason: "empty",
				budgetMs,
				remainingMs: scanBudgetMs,
				rows: 0,
			}),
		);
	}
	const protectedPids = collectAncestorPids(table, process.pid);
	protectedPids.add(process.pid);

	const orphans = options.orphanSweep
		? selectOrphanFixtureProcesses(table, {
				selfPid: process.pid,
				protectedPids,
			})
		: [];

	const perTreeProcesses = new Map();
	for (const removal of plan.remove) {
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
					remove: plan.remove.map((removal) => ({
						...removal,
						processes: (perTreeProcesses.get(removal.path) ?? []).map(
							(row) => ({ pid: row.pid, command: row.command }),
						),
					})),
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
		for (const removal of plan.remove) {
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
	const nowIso = new Date().toISOString();

	if (!options.dryRun) {
		for (const removal of plan.remove) {
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
			// Deliberately NOT budget-bound: this is the actual work, and
			// SIGKILLing git partway through a recursive delete leaves a
			// half-removed worktree plus a stale admin directory. The sweep's
			// budget gates whether removal STARTS, never whether it finishes.
			const removed = git(
				["worktree", "remove", "--force", "--force", removal.path],
				REPO_ROOT,
				REMOVE_TIMEOUT_MS,
			);
			if (removed === null) {
				console.error(`[hygiene] could not remove ${removal.path}`);
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
		if (plan.remove.length > 0)
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

		const deleted = deleteStaleBranches(gitBudget);
		for (const branch of deleted) say(`deleted branch ${branch}`);
	} else {
		for (const removal of plan.remove) {
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
			`${options.dryRun ? "dry-run: " : ""}${plan.remove.length} worktree(s), ` +
				`${orphans.length} orphan process(es)` +
				`${skippedForBudget > 0 ? `, ${skippedForBudget} not evaluated (budget ${budgetMs}ms)` : ""}` +
				`, ${table.length} process rows, ${Date.now() - startedAt}ms`,
		);
	}
}

/**
 * Delete agent-session branches left behind by removed worktrees. Runs after
 * removal so `checkedOut` reflects the post-removal reality.
 *
 * @returns {string[]}
 */
function deleteStaleBranches(gitBudget) {
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
	// Two passes on purpose: the cheap shape/upstream/checked-out filter first
	// (one for-each-ref line each, no subprocess), then the containment query
	// ONLY for survivors. A repo with dozens of local branches would otherwise
	// pay a revwalk per branch to answer a question that is already "no".
	const candidates = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [name, upstream, track] = line.split("\t");
		if (!name) continue;
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
	for (const name of selectStaleBranches(branches)) {
		if (git(["branch", "-D", name], REPO_ROOT, gitBudget()) !== null) {
			deleted.push(name);
		}
	}
	return deleted;
}

// Only run the CLI when this file is the entry point — not when a test
// imports parseArgs/parseProcessTable. Mirrors with-test-lock.mjs's own
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
