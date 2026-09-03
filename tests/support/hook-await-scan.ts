/**
 * Pure detection logic for the #2523 hook-await-bounds sweep
 * (`tests/config/hook-await-bounds.test.ts`), pulled out so it has exactly
 * ONE home: the governance test imports it to build the guard, and
 * `scripts/rekey-hook-await-exemptions.mjs` imports the SAME functions to
 * recompute occurrence keys mechanically after a merge shifts lines near a
 * flagged site. A vitest test file cannot be `import()`ed by a plain Node
 * script (its top-level `describe()`/`it()` calls need a running vitest
 * worker), so the detector has to live somewhere script-reachable — this
 * module, not a second hand-copied implementation (the single-source-of-truth
 * rule: a script that reimplements the regexes would drift from the test the
 * moment either one changes).
 *
 * No vitest import anywhere in this file — that is what makes it importable
 * from a bare `node` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { lineContentHash } from "../../clients/read-guard.js";
import {
	listSourceFiles,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "./sweep-kit.js";

/** The one module allowed to spell a timeout race: the canonical implementation. */
export const DEFINITION_FILE = "clients/deadline-utils.ts";

/** An `await` token that is a KEYWORD, not a property name or an identifier tail. */
const AWAIT_TOKEN = /(?<![.\w$])await(?![\w$])/g;

/**
 * A `Promise.race(` or `Promise.any(` call head. `Promise.any([work, delay])`
 * is the same shape as a `Promise.race` with a timer arm — first settlement
 * wins either way — so a hand-rolled bound spelled with `any` instead of
 * `race` must not slip past this scan (#2530 round 3 F3).
 */
const RACE_TOKEN = /\bPromise\s*\.\s*(?:race|any)\s*\(/g;

/** A timer arm: the shape that makes a race a hand-rolled bound. */
const TIMER_ARM = /\bsetTimeout\s*\(|\bAbortSignal\s*\.\s*timeout\s*\(/;

/**
 * How far ABOVE a `Promise.race(`/`Promise.any(` to look for the timer that
 * feeds it.
 *
 * The inline arm (`new Promise((r) => setTimeout(r, ms))` written straight
 * into the race) is the minority spelling. The dominant one hoists the arm
 * into a named local a few lines up — `clients/format-service.ts`'s
 * `timeoutPromise`, `clients/runtime-session.ts`'s
 * `readSequenceWithBudget` — and an inline-only detector called both of them
 * clean, which for a guard is the failure direction that hides. The window is
 * a line count rather than a scope walk for the same reason the rest of this
 * file is: a partial scope walk produces false negatives, a window produces
 * false positives, and a false positive is a table entry a reviewer reads.
 */
const RACE_TIMER_WINDOW = 25;

/** The only call shape that carries a real bound. See {@link SWEEP_HEURISTIC_LIMITS}. */
const BOUNDED_CALL = /^\s*bounded\s*\(/;

/**
 * Text of the call's own parentheses, starting at the `(` at or after
 * `from`. Paren matching over STRIPPED source, so a paren inside a comment or
 * string cannot unbalance it. Bounded by `maxChars` so one pathological
 * expression cannot turn this into a whole-file scan.
 */
function callArguments(
	stripped: string,
	from: number,
	maxChars = 4000,
): string {
	const open = stripped.indexOf("(", from);
	if (open < 0) return "";
	let depth = 0;
	const end = Math.min(stripped.length, open + maxChars);
	for (let i = open; i < end; i++) {
		const ch = stripped[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return stripped.slice(open, i + 1);
		}
	}
	return stripped.slice(open, end);
}

/**
 * Is the expression starting at `at` (just past an `await`) bounded?
 *
 * Exactly ONE accepted form: `bounded(...)` (#2530 round 3 F1). Round 1
 * accepted a second, `withDeadline`/`withTimeout`/`withBudget`/
 * `withinRemaining` whenever the word `signal` appeared anywhere in the
 * call's own parentheses — but none of those helpers takes a `signal`
 * parameter at all (`DeadlineOptions` has no such field), so the match was
 * pure text: `withBudget(sweep(cwd, { signal }), 500)` read as bounded
 * because `signal` was in the argument list, even though it is threaded to
 * the WRAPPED work, not to the race that decides how long this await waits.
 * That is exactly the deadline-only hole #2523 exists to close, reopened by
 * substring match. Zero sites in the scanned tree relied on it (measured:
 * the flagged set is identical with or without the allowance), so dropping
 * it costs nothing today and closes a hole slice 2 would otherwise walk
 * into.
 */
export function isBoundedAwait(stripped: string, at: number): boolean {
	const head = stripped.slice(at, at + 80);
	return BOUNDED_CALL.test(head);
}

/** 1-based line number of `offset` in `source`. */
function lineOf(source: string, offset: number): number {
	return source.slice(0, offset).split("\n").length;
}

/**
 * Every unbounded-await LINE in one already-stripped source, 1-based.
 *
 * Exported so the detector itself can be pinned against synthetic fixtures
 * (the mutation tests in `tests/config/hook-await-bounds.test.ts`) rather
 * than only against whatever happens to be in the tree today — a detector
 * that quietly stops detecting is defect shape 10 wearing a green check.
 */
export function findUnboundedAwaitLines(stripped: string): number[] {
	const hits = new Set<number>();
	for (const match of stripped.matchAll(AWAIT_TOKEN)) {
		const at = match.index + match[0].length;
		if (isBoundedAwait(stripped, at)) continue;
		hits.add(lineOf(stripped, match.index));
	}
	return [...hits].sort((a, b) => a - b);
}

/**
 * Every hand-rolled timeout race LINE in one already-stripped source,
 * 1-based: a `Promise.race(`/`Promise.any(` whose own arguments, or the 25
 * lines above it, spell a timer.
 */
export function findHandRolledRaceLines(stripped: string): number[] {
	const hits = new Set<number>();
	const lines = stripped.split("\n");
	for (const match of stripped.matchAll(RACE_TOKEN)) {
		const line = lineOf(stripped, match.index);
		const args = callArguments(stripped, match.index + match[0].length - 1);
		const above = lines
			.slice(Math.max(0, line - 1 - RACE_TIMER_WINDOW), line - 1)
			.join("\n");
		if (TIMER_ARM.test(args) || TIMER_ARM.test(above)) hits.add(line);
	}
	return [...hits].sort((a, b) => a - b);
}

/**
 * Nearest non-blank RAW line in `direction` from `index`, or `""` at the edge
 * of the file.
 */
function neighbourLine(
	rawLines: readonly string[],
	index: number,
	direction: -1 | 1,
): string {
	for (
		let i = index + direction;
		i >= 0 && i < rawLines.length;
		i += direction
	) {
		const line = rawLines[i] ?? "";
		if (line.trim().length > 0) return line;
	}
	return "";
}

/**
 * `stableOccurrenceKey` over the RAW lines, plus a neighbourhood suffix. See
 * `tests/config/hook-await-bounds.test.ts`'s module doc for the collision
 * measurements that justify the suffix.
 */
export function awaitOccurrenceKey(
	rel: string,
	rawLines: readonly string[],
	index: number,
): string {
	const base = stableOccurrenceKey(rel, rawLines, index);
	// NUL separator: `lineContentHash` strips whitespace, so a newline would
	// vanish and `a\nb` would hash the same as `ab`.
	const context = lineContentHash(
		[
			neighbourLine(rawLines, index, -1),
			neighbourLine(rawLines, index, 1),
		].join("\u0000"),
	);
	return `${base}~${context}`;
}

/** The four file groups a registered hook handler and its direct deps live in. */
export function hookPathFiles(repoRoot: string): string[] {
	const files: string[] = [];
	// Mechanical, never a hand-kept list: a NEW clients/runtime-*.ts is in
	// scope the moment it lands, which is the whole point of a governance
	// registry (a hand-maintained mirror of a directory is the defect).
	for (const absolute of listSourceFiles(path.join(repoRoot, "clients"), {
		skipTests: true,
	})) {
		const rel = relativePosix(repoRoot, absolute);
		if (/^clients\/runtime-[^/]+\.ts$/.test(rel)) files.push(absolute);
	}
	for (const rel of ["index.ts", "mcp/server.ts", "clients/mcp/session.ts"]) {
		const absolute = path.join(repoRoot, rel);
		if (fs.existsSync(absolute)) files.push(absolute);
	}
	return files.sort();
}

/** Every shipped source file the hand-rolled-race scan covers. */
export function shippedSourceFiles(repoRoot: string): string[] {
	const files = ["clients", "mcp", "tools"].flatMap((dir) => {
		const absolute = path.join(repoRoot, dir);
		return fs.existsSync(absolute)
			? listSourceFiles(absolute, { skipTests: true })
			: [];
	});
	const indexTs = path.join(repoRoot, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files.sort();
}

export interface FlaggedSite {
	key: string;
	detail: string;
}

/**
 * Run one line detector over one file group and key every hit.
 *
 * `prefix` namespaces the two families inside the single exemption table, so
 * an `await` and a race on the same line can never be confused for one
 * another (and `auditRegistry`'s stale check stays exact for both).
 */
export function scanFiles(
	repoRoot: string,
	files: readonly string[],
	detect: (stripped: string) => number[],
	prefix: string,
	skipRel?: (rel: string) => boolean,
): { occurrences: FlaggedSite[]; scanned: number } {
	const occurrences: FlaggedSite[] = [];
	let scanned = 0;
	for (const absolute of files) {
		const rel = relativePosix(repoRoot, absolute);
		if (skipRel?.(rel)) continue;
		scanned++;
		const raw = fs.readFileSync(absolute, "utf8");
		// Layout-preserving, so these line numbers and the hash inputs derived
		// from them line up with the raw source.
		const stripped = stripSource(raw);
		const rawLines = raw.split("\n");
		for (const line of detect(stripped)) {
			occurrences.push({
				key: `${prefix}${awaitOccurrenceKey(rel, rawLines, line - 1)}`,
				detail: `${rel}:${line}  ${(rawLines[line - 1] ?? "").trim().slice(0, 100)}`,
			});
		}
	}
	return { occurrences, scanned };
}
