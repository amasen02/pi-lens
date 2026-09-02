// Process-table access for scripts/, in two halves.
//
// The PURE half (#476, Layer B assertion 3: zero surviving LSP-server child
// processes after pi exits — the #472 orphan class) answers "does this
// command line look like a leaked LSP server, and is it NEW since the
// baseline snapshot", and is unit-testable with fake process tables.
//
// The IMPURE half is the platform listing itself: one `snapshotProcesses`
// plus its parser. PR #2438 review round 3 (F2) folded the second copy in
// here. `scripts/prune-agent-worktrees.mjs` and
// `scripts/compat-smoke-behavioral.mjs` had each grown their own
// `windowsExe` + `snapshotProcesses` pair with the same Windows CIM / POSIX
// `ps` split, differing only in which columns they asked for — so a fix to
// one (the exit-code check that review S5 added: a `ps` that prints a
// partial table and dies must not read as a complete one) did not reach the
// other. One function, a `fields` projection, both callers.
//
// NOTE for clients/: `clients/instance-reaper.ts` and
// `clients/resource-sampler.ts` hold further copies. They are NOT collapsed
// into this file — scripts/ is untyped .mjs tooling that ships nothing, and
// clients/ is the extension runtime with its own spawn seam and budget
// rails. That cross-boundary consolidation is filed separately.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Default ceiling for one process listing. */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 4_000;

/**
 * @typedef {"pid" | "ppid" | "command"} ProcessField
 * @typedef {{ pid: number, ppid: number, command: string, cwd?: string }} ProcRow
 */

/**
 * Per-field platform column names. `ps`'s `args` and CIM's `CommandLine` are
 * the same question asked twice; keeping the mapping in one table is what
 * lets a caller say `["pid", "command"]` and get the right query on both.
 */
const FIELD_COLUMNS = Object.freeze({
	pid: { wmi: "ProcessId", ps: "pid" },
	ppid: { wmi: "ParentProcessId", ps: "ppid" },
	command: { wmi: "CommandLine", ps: "args" },
});

/** The full projection, and the order every parser assumes. */
export const ALL_PROCESS_FIELDS = Object.freeze(["pid", "ppid", "command"]);

/**
 * Absolute path to a System32 executable. Windows resolves a bare
 * `powershell.exe` through PATH, which a caller can shadow; the sweep spawns
 * this to decide what to KILL, so the interpreter is named absolutely.
 *
 * @param {string} name
 * @returns {string}
 */
export function windowsExe(name) {
	return path.join(
		process.env.SystemRoot ?? path.join("C:", "Windows"),
		"System32",
		name,
	);
}

/**
 * Absolute path to POSIX `ps`, the same reasoning as `windowsExe` applied to
 * the other platform: this listing decides what the sweep KILLS, so the
 * interpreter is named absolutely rather than resolved through a PATH a
 * caller can shadow (master's compat-smoke already spawned `/bin/ps`; this
 * carries that into the shared listing). Falls back to the bare `ps` name
 * only when `/bin/ps` is absent, so a POSIX-like environment that keeps it
 * elsewhere still works.
 *
 * @returns {string}
 */
export function posixPsPath() {
	try {
		return fs.existsSync("/bin/ps") ? "/bin/ps" : "ps";
	} catch {
		return "ps";
	}
}

/**
 * Normalize and order a requested field list. `pid` is always present (it is
 * the row identity) and the order always follows `ALL_PROCESS_FIELDS`, so the
 * parser never has to be told the layout it is reading.
 *
 * @param {ReadonlyArray<ProcessField>|null|undefined} fields
 * @returns {ProcessField[]}
 */
export function normalizeProcessFields(fields) {
	const requested = new Set(
		(fields ?? ALL_PROCESS_FIELDS).filter((field) => field in FIELD_COLUMNS),
	);
	requested.add("pid");
	return ALL_PROCESS_FIELDS.filter((field) => requested.has(field));
}

/**
 * Parse a platform listing into rows.
 *
 * Windows CIM emits tab-joined fields, one per requested column. `ps` emits
 * whitespace-aligned columns whose LAST field (`args`) contains spaces, so it
 * is parsed positionally with the tail taken whole.
 *
 * Fields not requested are still present on the row at their zero value
 * (`ppid: 0`, `command: ""`), so consumers see one row shape regardless of
 * the projection.
 *
 * @param {string} out
 * @param {boolean} tabSeparated
 * @param {ReadonlyArray<ProcessField>} [fields]
 * @returns {ProcRow[]}
 */
export function parseProcessTable(
	out,
	tabSeparated,
	fields = ALL_PROCESS_FIELDS,
) {
	const layout = normalizeProcessFields(fields);
	const commandIndex = layout.indexOf("command");
	const rows = [];
	for (const line of String(out ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		/** @type {string[]|null} */
		let parts;
		if (tabSeparated) {
			const split = line.split("\t");
			if (split.length < layout.length - (commandIndex === -1 ? 0 : 1))
				continue;
			// The command is the tail: it may itself contain tabs.
			parts =
				commandIndex === -1
					? split
					: [
							...split.slice(0, commandIndex),
							split.slice(commandIndex).join("\t"),
						];
		} else {
			// Every leading column is numeric; the trailing command, if asked
			// for, takes the rest of the line verbatim.
			const numeric = commandIndex === -1 ? layout.length : commandIndex;
			const pattern = new RegExp(
				`^\\s*${Array.from({ length: numeric }, () => "(\\d+)").join("\\s+")}${
					commandIndex === -1 ? "\\s*$" : "\\s+(.*)$"
				}`,
			);
			const match = pattern.exec(line);
			if (!match) continue;
			parts = match.slice(1);
		}
		const value = (field) => {
			const at = layout.indexOf(field);
			return at === -1 ? undefined : parts[at];
		};
		const pid = Number(value("pid"));
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const ppid = Number(value("ppid"));
		rows.push({
			pid,
			ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
			command: value("command") ?? "",
		});
	}
	return rows;
}

/**
 * Snapshot the process table as `{ pid, ppid, command }` rows.
 *
 * Windows uses `Get-CimInstance` through `powershell -NoProfile` with an
 * explicit WQL projection (measured ~316ms for the query vs ~570ms for the
 * unprojected form on the #2435 box, plus ~208ms powershell startup) —
 * `tasklist` exposes no parent pid and no command line, and `wmic` is gone
 * from Windows 11. POSIX uses `ps -eo <cols>`.
 *
 * Never rejects. Returns `{ rows, ok }`: `ok` is false when the listing
 * failed, timed out, never spawned, or EXITED NON-ZERO — the last of which
 * used to be ignored (PR #2438 review S5), so a `ps` that printed a partial
 * table and then died read as a complete one. `ok` is the only evidence a
 * caller has that an ABSENCE from the table means anything. Bounded by
 * `timeoutMs` so a hook can never hang a session on a wedged WMI service.
 *
 * @param {ReadonlyArray<ProcessField>} [fields]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ rows: ProcRow[], ok: boolean }>}
 */
export function snapshotProcesses(
	fields = ALL_PROCESS_FIELDS,
	timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS,
) {
	const layout = normalizeProcessFields(fields);
	const command = isWindows
		? windowsExe("WindowsPowerShell\\v1.0\\powershell.exe")
		: posixPsPath();
	const args = isWindows
		? [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Get-CimInstance -Query "SELECT ${layout
					.map((field) => FIELD_COLUMNS[field].wmi)
					.join(",")} FROM Win32_Process" | ForEach-Object { "${layout
					.map((field) => `$($_.${FIELD_COLUMNS[field].wmi})`)
					.join("`t")}" }`,
			]
		: ["-eo", layout.map((field) => `${FIELD_COLUMNS[field].ps}=`).join(",")];

	return new Promise((resolve) => {
		let settled = false;
		const finish = (rows, ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ rows, ok });
		};
		let child;
		const timer = setTimeout(() => {
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
			finish([], false);
		}, timeoutMs);
		try {
			child = spawn(command, args, {
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish([], false);
			return;
		}
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk.toString();
		});
		child.once("error", () => finish([], false));
		// A non-zero exit (or a signal) means the listing is PARTIAL at best.
		// Whatever it printed is not evidence of what is NOT running, which is
		// exactly the question the orphan predicate asks of it.
		child.once("close", (code, signal) =>
			finish(parseProcessTable(out, isWindows, layout), code === 0 && !signal),
		);
	});
}

/**
 * Command-line substrings that identify an LSP server process we launch.
 * Deliberately narrow — matching on the distinctive binary/module name, not
 * a generic "node" or "language-server" fragment, so the scan doesn't flag
 * unrelated node processes on a shared CI runner.
 */
export const LSP_PROCESS_MARKERS = [
	"typescript-language-server",
	"ast-grep lsp",
	"ast-grep-lsp",
	"pyright-langserver",
	"vscode-json-languageserver",
];

/**
 * @typedef {{ pid: number, command: string }} ProcessRow
 */

/**
 * True iff `command` looks like one of the LSP servers pi-lens spawns.
 *
 * @param {string} command
 */
export function isLspServerCommand(command) {
	const lower = command.toLowerCase();
	return LSP_PROCESS_MARKERS.some((marker) =>
		lower.includes(marker.toLowerCase()),
	);
}

/**
 * Diff a `before` and `after` process snapshot and return the LSP-server
 * rows that are NEW in `after` (i.e. survived/spawned during the run and are
 * still alive after pi exited — the orphan class #472 fixed). Matches by pid
 * — a row present in both snapshots with the same pid is presumed to be an
 * unrelated pre-existing process, not something this run leaked.
 *
 * @param {ProcessRow[]} before
 * @param {ProcessRow[]} after
 * @returns {ProcessRow[]}
 */
export function diffSurvivingLspProcesses(before, after) {
	const beforePids = new Set(before.map((r) => r.pid));
	return after.filter(
		(row) => !beforePids.has(row.pid) && isLspServerCommand(row.command),
	);
}

/**
 * @typedef {{ rows: ProcessRow[], ok: boolean }} ProcessSnapshot
 */

/**
 * The "no surviving LSP process" assertion (compat-smoke-behavioral.mjs,
 * Layer B assertion 3), extracted so it is unit-testable without spawning a
 * real `ps`/CIM listing.
 *
 * An absence of a row from `after` only means something when BOTH snapshots
 * are known-complete: `snapshotProcesses`'s `ok` is the only evidence of
 * that (see its doc comment). A failed or timed-out listing yields an empty
 * table, which must never read as "no leak" — that is silence, not
 * evidence, and would make a caller-side outage report a false pass
 * (PR #2438 review round 4, F-A).
 *
 * @param {ProcessSnapshot} before
 * @param {ProcessSnapshot} after
 * @returns {{ id: string, pass: boolean, detail: string }}
 */
export function evaluateNoSurvivingLspProcesses(before, after) {
	const id = "no-surviving-lsp-processes";
	if (!before.ok || !after.ok) {
		return {
			id,
			pass: false,
			detail: `process listing unavailable (before.ok=${before.ok}, after.ok=${after.ok}); cannot verify no LSP process survived`,
		};
	}
	const surviving = diffSurvivingLspProcesses(before.rows, after.rows);
	return {
		id,
		pass: surviving.length === 0,
		detail:
			surviving.length === 0
				? "no new LSP-server processes survived pi's exit"
				: `${surviving.length} surviving process(es): ${surviving.map((p) => `pid=${p.pid} ${p.command.slice(0, 80)}`).join("; ")}`,
	};
}
