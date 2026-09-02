/**
 * scripts/lib/worktree-hygiene.mjs (#2435)
 *
 * PURE decision logic for scripts/prune-agent-worktrees.mjs: which agent
 * worktrees may be removed, which processes may be killed, and how the kill
 * ledger stays bounded. Split from the CLI (which owns `git worktree list`,
 * the Windows CIM / POSIX `ps` process listing, and the actual
 * `process.kill`) for the same reason scripts/lib/process-scan.mjs was split
 * from compat-smoke-behavioral.mjs: the risky part is the DECISION, and a
 * decision is only testable if it is a function of a table rather than of
 * the machine. Every test in tests/scripts/worktree-hygiene.test.ts feeds a
 * synthetic worktree/process table here; nothing in this file can kill or
 * delete anything.
 *
 * Safety posture -- the rails are the contract (#2435 acceptance criteria):
 *   - A DIRTY worktree is never removed. No flag overrides this.
 *   - A worktree whose HEAD is not contained in any `origin/*` ref is never
 *     removed (unpushed work is unrecoverable once the tree is gone). No
 *     flag overrides this.
 *   - A worktree younger than `minAgeMs` is kept, and a worktree whose git
 *     lock record names a LIVE pid is kept -- both overridable ONLY by
 *     `--only`, which is how the SubagentStop hook names the one tree whose
 *     agent just finished. `--only` never overrides dirty/unpushed.
 *   - Kills are by pid, only for processes matched to a removable worktree
 *     path or to a `tests/fixtures/*` / `tests/support/*` helper, and never
 *     for this process or any of its ancestors.
 *   - A fixture helper whose PARENT IS STILL ALIVE is never killed -- that is
 *     a running test, not a leak.
 *
 * On the git lock record: Claude Code locks each agent worktree with a
 * reason like `claude agent agent-<id> (pid <pid>)`, where the pid is the
 * TOP-LEVEL Claude Code process shared by every agent in that session -- not
 * the individual agent. So a live lock pid means "this Claude Code session
 * is still running", which is the right default keep signal for a
 * SessionStart sweep (it protects sibling agents' trees) and exactly the
 * wrong one for SubagentStop (the session is alive by definition there).
 * Hence: keep by default, `--only` overrides.
 */

import path from "node:path";

/** Default minimum worktree age before an unnamed tree is eligible (30m). */
export const DEFAULT_MIN_AGE_MS = 30 * 60_000;

/** Max records retained in the hygiene ledger (bounded telemetry). */
export const DEFAULT_LOG_MAX_LINES = 500;

/** Max characters of a command line recorded in a kill record. */
export const MAX_RECORDED_COMMAND_CHARS = 300;

/**
 * Path segment that identifies a Claude Code agent worktree. Matched against
 * a separator-normalized path, so `\` and `/` spellings both hit.
 */
export const AGENT_WORKTREE_SEGMENT = "/.claude/worktrees/agent-";

/**
 * Command-line markers for long-running test helpers that may outlive their
 * runner. `tests/fixtures/` and `tests/support/` are the two directories the
 * repo spawns helper processes from; `fake-lsp-server.mjs` (#1660) is the
 * one observed leaker (#2435 evidence) and is listed explicitly so a grep
 * for it lands here. Matching is on the DIRECTORY path, not on "node", so an
 * unrelated node process is never a candidate.
 */
export const FIXTURE_HELPER_MARKERS = [
	"tests/fixtures/",
	"tests/support/",
	"fake-lsp-server.mjs",
];

/**
 * Normalize a filesystem path for comparison: absolute, forward slashes,
 * lowercased, no trailing separator. Case-folding is unconditional rather
 * than win32-only because these strings are also compared against command
 * lines captured from a process table, where the casing of a path fragment
 * is not under our control on any OS. Mirrors the read-guard path-key
 * invariant (one normalizer, never raw keys -- #210).
 *
 * @param {string} p
 * @returns {string}
 */
export function toComparablePath(p) {
	if (typeof p !== "string" || p.length === 0) return "";
	return path
		.resolve(p)
		.split(path.sep)
		.join("/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/**
 * Same normalization for a string that is NOT a path (a command line): only
 * separator + case folding, no `path.resolve`, so an embedded absolute path
 * fragment still compares equal to a normalized worktree path.
 *
 * @param {string} text
 * @returns {string}
 */
export function toComparableText(text) {
	if (typeof text !== "string") return "";
	return text.split("\\").join("/").toLowerCase();
}

/**
 * True iff `p` is (or is inside) a `.claude/worktrees/agent-*` directory.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isAgentWorktreePath(p) {
	return toComparablePath(p).includes(AGENT_WORKTREE_SEGMENT);
}

/**
 * Parse `git worktree list --porcelain` output into rows. Blocks are
 * blank-line separated; unknown attribute lines are ignored rather than
 * throwing, so a future git attribute cannot break the sweep.
 *
 * @param {string} porcelain
 * @returns {{ path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, locked: boolean, lockedReason: string|null, prunable: boolean }[]}
 */
export function parseWorktreeList(porcelain) {
	const rows = [];
	let current = null;
	const flush = () => {
		if (current) rows.push(current);
		current = null;
	};
	for (const rawLine of String(porcelain ?? "").split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line === "") {
			flush();
			continue;
		}
		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? "" : line.slice(space + 1);
		if (key === "worktree") {
			flush();
			current = {
				path: value,
				head: null,
				branch: null,
				detached: false,
				bare: false,
				locked: false,
				lockedReason: null,
				prunable: false,
			};
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") current.head = value || null;
		else if (key === "branch") current.branch = value || null;
		else if (key === "detached") current.detached = true;
		else if (key === "bare") current.bare = true;
		else if (key === "locked") {
			current.locked = true;
			current.lockedReason = value || null;
		} else if (key === "prunable") current.prunable = true;
	}
	flush();
	return rows;
}

/**
 * Extract the pid from a git worktree lock reason such as
 * `claude agent agent-abc (pid 55260)`. Returns null when the reason carries
 * no pid -- which is treated as "no live-owner evidence", NOT as "alive".
 *
 * @param {string|null|undefined} lockedReason
 * @returns {number|null}
 */
export function parseLockPid(lockedReason) {
	if (typeof lockedReason !== "string") return null;
	const match = /\bpid[\s:=]+(\d+)/i.exec(lockedReason);
	if (!match) return null;
	const pid = Number(match[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Parse a duration: bare digits are milliseconds; `ms`/`s`/`m`/`h` suffixes
 * scale. Returns null for anything unparseable so the caller can reject it
 * loudly instead of silently defaulting (a mis-typed `--min-age` that
 * quietly became 0 would disable the age rail).
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseDuration(text) {
	const trimmed = String(text ?? "")
		.trim()
		.toLowerCase();
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return null;
	const unit = match[2] ?? "ms";
	const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
	return Math.round(value * scale);
}

/**
 * @typedef {object} WorktreeCandidate
 * @property {string} path            Absolute worktree path.
 * @property {string|null} [head]     HEAD sha.
 * @property {string|null} [branch]   Full ref (`refs/heads/...`) or null.
 * @property {boolean} dirty          `git status --porcelain` was non-empty.
 * @property {boolean} pushed         HEAD is contained in some `origin/*` ref.
 * @property {number} mtimeMs         Newest observed activity timestamp.
 * @property {boolean} [locked]
 * @property {number|null} [lockPid]
 * @property {boolean} [unevaluated]  The caller ran out of time budget before
 *   it could read this tree's dirty/pushed state. Never removable: an
 *   unanswered safety question is a NO, and the next sweep tries again.
 */

/**
 * Decide, for a table of worktree candidates, which may be removed.
 *
 * Rails are evaluated in a fixed order and the FIRST one that fires wins, so
 * a keep reason is always the single most important reason -- that is what
 * the dry-run prints and what the tests assert against.
 *
 * @param {object} options
 * @param {WorktreeCandidate[]} options.worktrees
 * @param {number} options.nowMs
 * @param {number} [options.minAgeMs]
 * @param {string[]|null} [options.only]   Explicit paths; null = sweep all.
 * @param {string|string[]|null} [options.selfPath] Worktree(s) this process
 *   lives in — its own file location AND its cwd can sit in different trees,
 *   and neither may ever be removed out from under a running sweep.
 * @param {(pid: number) => boolean} [options.isPidAlive]
 * @returns {{ remove: { path: string, branch: string|null, ageMs: number, locked: boolean, selected: boolean }[], keep: { path: string, reason: string, detail: string|null }[] }}
 */
export function planWorktreePrune({
	worktrees,
	nowMs,
	minAgeMs = DEFAULT_MIN_AGE_MS,
	only = null,
	selfPath = null,
	isPidAlive = () => false,
}) {
	const selectedKeys = only ? new Set(only.map(toComparablePath)) : null;
	const selfKeys = new Set(
		(Array.isArray(selfPath) ? selfPath : selfPath ? [selfPath] : [])
			.map(toComparablePath)
			.filter(Boolean),
	);
	const remove = [];
	const keep = [];

	for (const row of worktrees ?? []) {
		const key = toComparablePath(row.path);
		// Clamped at 0: a tree another agent is actively writing can carry an
		// mtime a few ms in the future relative to the snapshot `nowMs`, and a
		// negative age in a "too-young" message reads as a bug.
		const ageMs = Math.max(0, nowMs - (Number(row.mtimeMs) || 0));
		const selected = selectedKeys ? selectedKeys.has(key) : false;
		const push = (reason, detail = null) =>
			keep.push({ path: row.path, reason, detail });

		if (!isAgentWorktreePath(row.path)) {
			push("not-agent-worktree");
			continue;
		}
		if (selfKeys.has(key)) {
			push("self", "this sweep is running inside it");
			continue;
		}
		if (selectedKeys && !selected) {
			push("not-selected", "--only named other trees");
			continue;
		}
		if (row.unevaluated) {
			push("not-evaluated", "time budget exhausted before this tree was read");
			continue;
		}
		// Hard rails: no flag, --only included, overrides these two.
		if (row.dirty) {
			push("dirty", "uncommitted changes would be destroyed");
			continue;
		}
		if (!row.pushed) {
			push("unpushed", "HEAD is not contained in any origin/* ref");
			continue;
		}
		// Soft rails: --only (SubagentStop naming the finished agent's tree)
		// overrides both.
		const lockPid = row.lockPid ?? null;
		if (!selected && row.locked && lockPid !== null && isPidAlive(lockPid)) {
			push("locked-live", `git lock names live pid ${lockPid}`);
			continue;
		}
		if (!selected && ageMs < minAgeMs) {
			push("too-young", `age ${ageMs}ms < min ${minAgeMs}ms`);
			continue;
		}
		remove.push({
			path: row.path,
			branch: row.branch ?? null,
			ageMs,
			locked: Boolean(row.locked),
			selected,
		});
	}

	return { remove, keep };
}

/**
 * Order candidates so anything `only` names is inspected FIRST. The caller
 * enriches trees under a wall-clock budget (a hook has ~2s), and a
 * SubagentStop sweep has exactly one tree it cares about — it must never
 * lose its budget to unrelated siblings that happened to sort earlier.
 * Stable, so relative order within each group is preserved.
 *
 * @template {{ path: string }} T
 * @param {T[]} rows
 * @param {string[]|null} only
 * @returns {T[]}
 */
export function orderBySelection(rows, only) {
	const list = [...(rows ?? [])];
	if (!only || only.length === 0) return list;
	const selectedKeys = new Set(only.map(toComparablePath));
	const rank = (row) => (selectedKeys.has(toComparablePath(row.path)) ? 0 : 1);
	return list.sort((a, b) => rank(a) - rank(b));
}

/**
 * Runtimes that can be launched with a fixture script as their argument.
 * Anything else (a shell, an editor, a grep) is never a fixture helper no
 * matter what its command line mentions.
 */
const SCRIPT_RUNTIMES = new Set(["node", "bun", "deno", "npx", "tsx"]);

/** `-e "code"` / `--eval` / `-p` / `--print`: a code string, not a script. */
const INLINE_CODE_FLAG_RE = /(?:^|\s)(?:-e|-p|--eval|--print)(?:\s|=|$)/;

/**
 * The executable of a command line: the first token, honoring one level of
 * quoting (`"C:\Program Files\nodejs\node.exe" -e ...`), lowercased,
 * basename only, `.exe` stripped.
 *
 * @param {string} normalizedCommand Output of toComparableText.
 * @returns {string}
 */
function commandExecutable(normalizedCommand) {
	const trimmed = normalizedCommand.trimStart();
	let token;
	if (trimmed.startsWith('"')) {
		const close = trimmed.indexOf('"', 1);
		token = close === -1 ? trimmed.slice(1) : trimmed.slice(1, close);
	} else {
		const space = trimmed.search(/\s/);
		token = space === -1 ? trimmed : trimmed.slice(0, space);
	}
	const base = token.split("/").pop() ?? "";
	return base.replace(/\.(exe|cmd|bat)$/, "");
}

/**
 * True iff a command line names a long-running test helper we are willing to
 * reap. THREE conditions, and the last two exist because a plain substring
 * match is dangerous: it is satisfied by any process that merely MENTIONS
 * the path. Both false positives below were observed live on the #2435 box
 * while validating this sweep —
 *   - `pwsh.exe -Command "... -like \"*fake-lsp-server*\" ..."`, i.e. the
 *     process-table QUERY looking for the leak, and
 *   - `node.exe -e "const c=spawn(...,['.../tests/fixtures/...'])"`, i.e. a
 *     supervisor that merely references the fixture,
 * and either would have been killed by a bare `includes()`. So:
 *   1. the command must reference a `tests/fixtures/` or `tests/support/`
 *      path (or the known `fake-lsp-server.mjs` module);
 *   2. its executable must be a script RUNTIME (node/bun/deno/...), never a
 *      shell, an editor or a search tool;
 *   3. it must not be an inline-code invocation (`-e` / `--eval` / `-p`),
 *      which references a path inside a string rather than running it.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isFixtureHelperCommand(command) {
	const normalized = toComparableText(command);
	if (!normalized) return false;
	const mentionsFixture = FIXTURE_HELPER_MARKERS.some((marker) =>
		normalized.includes(marker.toLowerCase()),
	);
	if (!mentionsFixture) return false;
	if (!SCRIPT_RUNTIMES.has(commandExecutable(normalized))) return false;
	return !INLINE_CODE_FLAG_RE.test(normalized);
}

/**
 * @typedef {{ pid: number, ppid?: number, command: string, cwd?: string }} ProcRow
 */

/**
 * Walk the ppid chain up from `startPid` and return every ancestor pid found
 * in the snapshot (excluding `startPid` itself). Cycle-safe. Used to build
 * the never-kill set: reaping our own parent (the hook runner, the shell,
 * the Claude Code process) would take the session down with it.
 *
 * @param {ProcRow[]} rows
 * @param {number} startPid
 * @returns {Set<number>}
 */
export function collectAncestorPids(rows, startPid) {
	const byPid = new Map();
	for (const row of rows ?? []) byPid.set(row.pid, row);
	const ancestors = new Set();
	let cursor = byPid.get(startPid);
	while (cursor && typeof cursor.ppid === "number" && cursor.ppid > 0) {
		if (ancestors.has(cursor.ppid)) break;
		ancestors.add(cursor.ppid);
		cursor = byPid.get(cursor.ppid);
	}
	ancestors.delete(startPid);
	return ancestors;
}

/**
 * A concurrently running copy of the sweep itself. Never a kill candidate:
 * a sibling hygiene run names the very worktree it is removing on its own
 * command line, and killing it mid-`git worktree remove` would leave the
 * worktree admin directory half-deleted.
 */
const SELF_COMMAND_MARKER = "prune-agent-worktrees";

/**
 * Processes whose command line or cwd is under `targetPath`. Used only for
 * worktrees the plan has ALREADY cleared for removal (clean + pushed +
 * eligible), so the directory is by construction not in active use.
 *
 * @param {ProcRow[]} rows
 * @param {string} targetPath
 * @param {{ protectedPids?: Set<number> }} [options]
 * @returns {ProcRow[]}
 */
export function selectProcessesUnderPath(rows, targetPath, options = {}) {
	const needle = toComparablePath(targetPath);
	if (!needle) return [];
	const protectedPids = options.protectedPids ?? new Set();
	return (rows ?? []).filter((row) => {
		if (!Number.isInteger(row.pid) || row.pid <= 0) return false;
		if (protectedPids.has(row.pid)) return false;
		const command = toComparableText(row.command);
		if (command.includes(SELF_COMMAND_MARKER)) return false;
		const cwd = row.cwd ? toComparablePath(row.cwd) : "";
		return (
			(command !== "" && command.includes(needle)) ||
			(cwd !== "" && (cwd === needle || cwd.startsWith(`${needle}/`)))
		);
	});
}

/**
 * The orphan predicate (#2435 AC 2): a fixture helper whose parent is gone.
 *
 * Parent liveness is read from the SNAPSHOT, not from `process.kill(ppid,
 * 0)`: the snapshot is a full process table taken at one instant, so
 * "ppid absent from the table" is exactly "the parent has exited". This also
 * fails SAFE under pid recycling -- a recycled ppid reads as present, so the
 * helper is KEPT, never wrongly killed.
 *
 * @param {ProcRow[]} rows
 * @param {{ selfPid?: number, protectedPids?: Set<number> }} [options]
 * @returns {{ row: ProcRow, reason: string }[]}
 */
export function selectOrphanFixtureProcesses(rows, options = {}) {
	const table = rows ?? [];
	const livePids = new Set(table.map((row) => row.pid));
	const selfPid = options.selfPid ?? -1;
	const protectedPids = options.protectedPids ?? new Set();
	const orphans = [];
	for (const row of table) {
		if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
		if (row.pid === selfPid || protectedPids.has(row.pid)) continue;
		if (!isFixtureHelperCommand(row.command)) continue;
		const ppid = row.ppid;
		const parentAlive =
			typeof ppid === "number" && ppid > 0 && livePids.has(ppid);
		if (parentAlive) continue;
		orphans.push({
			row,
			reason:
				typeof ppid === "number" && ppid > 0
					? `orphan test fixture (parent pid ${ppid} is gone)`
					: "orphan test fixture (no live parent recorded)",
		});
	}
	return orphans;
}

/**
 * Branch-name shapes an agent session creates, and the only ones this sweep
 * will ever delete. A `fix/*` / `feat/*` branch is deliberately NOT here:
 * those are the work itself and outlive their worktree.
 */
export const AGENT_BRANCH_SHAPES = [
	/^pr-\d+$/i,
	/^review\//i,
	/^fixround-/i,
	/^worktree-agent-/i,
];

/**
 * Local branches safe to delete after their worktree is gone. THREE
 * conditions, all required:
 *   - the name matches an agent-session shape (above);
 *   - no surviving worktree has it checked out;
 *   - its head is contained in some `origin/*` ref, AND its upstream is
 *     either gone (the PR branch was deleted on merge) or was never set
 *     (a `worktree-agent-*` snapshot branch that only ever tracked master).
 *
 * `containedInOrigin` is the load-bearing one: "upstream is gone" alone
 * would happily delete a branch carrying local commits that were never
 * pushed anywhere.
 *
 * @param {{ name: string, containedInOrigin: boolean, hasUpstream: boolean, upstreamGone: boolean, checkedOut: boolean }[]} branches
 * @returns {string[]}
 */
export function selectStaleBranches(branches) {
	return (branches ?? [])
		.filter(
			(branch) => isAgentBranchCandidate(branch) && branch.containedInOrigin,
		)
		.map((branch) => branch.name);
}

/**
 * The CHEAP half of selectStaleBranches: everything decidable from a single
 * `git for-each-ref` line, with no per-branch containment query. Split out
 * (rather than duplicated in the caller) so the shape and upstream rules have
 * exactly one definition: the CLI pre-filters with this, runs the expensive
 * containment check only on survivors, then hands the result back to
 * selectStaleBranches for the final verdict.
 *
 * @param {{ name: string, hasUpstream: boolean, upstreamGone: boolean, checkedOut: boolean }} branch
 * @returns {boolean}
 */
export function isAgentBranchCandidate(branch) {
	if (!branch || typeof branch.name !== "string") return false;
	if (branch.checkedOut) return false;
	if (branch.hasUpstream && !branch.upstreamGone) return false;
	return AGENT_BRANCH_SHAPES.some((shape) => shape.test(branch.name));
}

/**
 * Build one bounded hygiene ledger record. The command line is truncated to
 * MAX_RECORDED_COMMAND_CHARS: a full Windows command line can be kilobytes,
 * and an unbounded field in an append-only log is the classic
 * "bounded along one axis, unbounded along another" leak.
 *
 * @param {{ pid: number, command: string, reason: string, worktree?: string|null, dryRun?: boolean, killed?: boolean, error?: string|null, nowIso?: string }} input
 * @returns {string}
 */
export function formatKillRecord(input) {
	const command = String(input.command ?? "");
	const record = {
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.kill",
		pid: input.pid,
		reason: input.reason,
		worktree: input.worktree ?? null,
		dryRun: Boolean(input.dryRun),
		killed: Boolean(input.killed),
		command:
			command.length > MAX_RECORDED_COMMAND_CHARS
				? `${command.slice(0, MAX_RECORDED_COMMAND_CHARS)}...`
				: command,
	};
	if (input.error) record.error = String(input.error).slice(0, 200);
	return JSON.stringify(record);
}

/**
 * Build one bounded hygiene ledger record for a worktree removal. Same
 * bounded-field discipline as formatKillRecord: this is the ONLY evidence a
 * `--quiet` hook run leaves behind, so it has to carry the verdict, not just
 * the path.
 *
 * @param {{ path: string, branch?: string|null, ageMs: number, dryRun?: boolean, removed?: boolean, error?: string|null, nowIso?: string }} input
 * @returns {string}
 */
export function formatWorktreeRecord(input) {
	const record = {
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.worktree-removed",
		worktree: String(input.path ?? "").slice(0, MAX_RECORDED_COMMAND_CHARS),
		branch: input.branch ?? null,
		ageMs: Math.round(Number(input.ageMs) || 0),
		dryRun: Boolean(input.dryRun),
		removed: Boolean(input.removed),
	};
	if (input.error) record.error = String(input.error).slice(0, 200);
	return JSON.stringify(record);
}

/**
 * Build one bounded hygiene ledger record for a DEGRADED process scan.
 *
 * Without this the orphan sweep's most likely failure — a loaded box where
 * the process listing cannot finish inside the budget — leaves nothing behind
 * but a stderr line the hook runner discards, and the sweep looks like it ran
 * clean when it actually ran blind. Shape 10/13 of the defect catalog: a
 * degradation must be recorded, not merely survived.
 *
 * @param {{ reason: "skipped"|"empty", budgetMs: number, remainingMs?: number, rows?: number, nowIso?: string }} input
 * @returns {string}
 */
export function formatScanRecord(input) {
	return JSON.stringify({
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.scan-degraded",
		reason: input.reason,
		budgetMs: Math.round(Number(input.budgetMs) || 0),
		remainingMs:
			input.remainingMs === undefined
				? null
				: Math.round(Number(input.remainingMs) || 0),
		rows: Math.round(Number(input.rows) || 0),
	});
}

/**
 * Keep the ledger bounded: append `newLines`, then retain only the newest
 * `maxLines`. Pure so the retention arithmetic is testable without touching
 * a real log file.
 *
 * @param {string[]} existingLines
 * @param {string[]} newLines
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function pruneLogLines(
	existingLines,
	newLines,
	maxLines = DEFAULT_LOG_MAX_LINES,
) {
	const limit =
		Number.isFinite(maxLines) && maxLines > 0
			? Math.floor(maxLines)
			: DEFAULT_LOG_MAX_LINES;
	const all = [...(existingLines ?? []), ...(newLines ?? [])].filter(
		(line) => typeof line === "string" && line.trim() !== "",
	);
	return all.length <= limit ? all : all.slice(all.length - limit);
}
