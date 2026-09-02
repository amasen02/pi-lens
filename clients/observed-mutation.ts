/**
 * The observational mutation net (#2430).
 *
 * ## What it is
 *
 * `clients/mutating-tool.ts` classifies a mutation by NAME or by input SHAPE.
 * Both tiers are finite and the population of third-party edit tools is not, so
 * a tool pi-lens has never met is dropped before the first bookkeeping call —
 * no read-guard stamp, no `turn-state.json` entry, no deferred format.
 *
 * This module makes detection OBSERVATIONAL. It watches a bounded file set
 * around a call the seam could not classify, and if something changed it
 * replays the change through the mutation bridge as a real `kind: "edit"`. The
 * tool is then ATTRIBUTED (`clients/mutation-attribution.ts`), so a later
 * session on the same project classifies it from disk with no snapshot at all.
 *
 * Three layers, cheapest first:
 *
 * 1. **Nothing at all** for a tool the seam already classifies. `arm` is never
 *    reached: `runtime-tool-call.ts` only calls in when `classifyMutatingTool`
 *    returned `undefined` or the attribution is still provisional, and the
 *    first thing `arm` does is a map lookup.
 * 2. **Arm + diff** for an unclassified call whose input carries a path-shaped
 *    field, bounded to THAT PATH ALONE. Paid at most a handful of times per
 *    tool name per session (see `CLEAN_OBSERVATION_ARM_LIMIT` and
 *    `PERSIST_AFTER_OBSERVATIONS`).
 * 3. **The settled sweep** at `agent_settled`, before the deferred drain, for
 *    tools with no path field at all. It stat-checks the tracked-file set
 *    incrementally and NEVER walks the workspace.
 *
 * ## The observation universe is the TARGET PATH (#2449 review round 2)
 *
 * The first cut snapshotted the target's whole DIRECTORY plus the tracked-file
 * set. That was wrong in both directions and expensive in a third:
 *
 * - it attributed a SIBLING's change to the tool under observation, so a
 *   background write during a `read`-shaped call taught pi-lens that `read`
 *   mutates (round-2 finding F4);
 * - it made the arm cost scale with directory size and tracked-set size
 *   (~44ms warm), for a verdict about ONE path;
 * - it duplicated the settled sweep's job. The tracked set is the SWEEP's
 *   domain; the armed observation's domain is the path the tool named.
 *
 * So the universe is now: the path-shaped field's file, or — when that path is
 * a DIRECTORY — that directory's own entries, non-recursively, capped at
 * {@link OBSERVED_TARGET_DIR_MAX_ENTRIES}. Nothing else. A tool that changes a
 * file it never named is the settled sweep's business, not the armed
 * observation's, and the sweep says so honestly rather than guessing.
 *
 * ## What layer 3 cannot see, stated rather than hidden
 *
 * The sweep compares against a ledger seeded from files pi-lens has ALREADY
 * seen. A file that was never read, never written, never diagnosed and never
 * opened by a language server has no baseline, so its first drift only seeds
 * the ledger and is not reported. That is the documented limitation in #2430's
 * third acceptance criterion; the alternative is a workspace walk, which the
 * issue rules out.
 *
 * The sweep is also INCREMENTAL (round-2 finding F3). A full hash of 400
 * tracked files cannot finish inside a 200ms capture budget, so the first cut
 * timed out at every realistic size and never ran at all. It now stats a
 * bounded window per turn from a carried cursor, reads a file only when its
 * size or mtime actually moved, and reports its own coverage
 * (`scanned`/`remaining`/`cursor`) so a partial pass is never read as a clean
 * one.
 *
 * ## Bounds (AGENTS.md async rule, both directions)
 *
 * Every ASYNC step here carries a TIMEOUT and an `AbortSignal` race, and every
 * capture is additionally bounded by a file cap and a hash-byte budget. The
 * ARM shares a per-turn wall-clock budget; exhausting it emits a bounded
 * `observed_mutation_budget_exhausted` record and a degradation-ledger tally —
 * it is never a silent skip (catalog shape 10).
 *
 * The SETTLE is deliberately synchronous and deliberately NOT budget-gated.
 * `handleToolResult` may not yield before it dispatches the pipeline (#1086,
 * asserted by `tests/clients/runtime-tool-result-debounce.test.ts`), and a
 * settle clamped to a spent budget silently dropped real mutations (round-2
 * findings F1 and F5). The snapshot already exists and the post-capture is one
 * path, so it always completes for the target; a directory target's remaining
 * entries are the only part a deadline can cut, and a cut capture says so.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { emitBounded } from "./bounded-telemetry.js";
import { logLatency } from "./latency-logger.js";
import {
	noteObservedClean,
	noteObservedMutation,
	shouldArmObservationForTool,
} from "./mutation-attribution.js";
import {
	captureFileStatsForPaths,
	captureFileStatsForPathsSync,
	diffFileStats,
	type FileStatsSnapshot,
	OPAQUE_MTIME_TOLERANCE_MS,
} from "./opaque-mutation-scan.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";
import { lineContentHash } from "./read-guard.js";

/**
 * Wall-clock CEILING for the ARM capture — not its cost.
 *
 * Since the universe collapsed to the target path this is one `stat`, one
 * optional `readdir`, and a bounded set of stat+hash pairs. The ceiling is
 * generous on purpose: a slow filesystem (#462 measured 1.3ms per stat on 9p)
 * must not turn every first observation into a timeout, which is the least
 * useful possible outcome.
 */
export const OBSERVED_CAPTURE_BUDGET_MS = 200;

/**
 * Cumulative ceiling for every ARMED capture in one turn. A turn that calls
 * twenty unclassified tools pays this once, not twenty times. The SETTLE does
 * not consult it — see the module header.
 */
export const OBSERVED_TURN_BUDGET_MS = 600;

/**
 * Wall-clock ceiling for the SYNCHRONOUS settle capture.
 *
 * Tighter than {@link OBSERVED_CAPTURE_BUDGET_MS} because this one blocks the
 * event loop: the settle cannot yield without breaking #1086's ordering
 * contract (see {@link settleObservedMutation}), so its bound is a stall
 * budget, not a latency budget. Measured on this repo: a file target settles in
 * ~0.35ms and a full 42-entry DIRECTORY target in ~13ms, so this clears the
 * realistic worst case with room and only bites on a filesystem far slower than
 * the one it was measured on.
 *
 * It can never cut the TARGET itself — `captureFileStatsForPathsSync` always
 * runs its first entry — so F5's "the settle always completes for the target
 * path" holds regardless of the clock.
 */
export const OBSERVED_SETTLE_DEADLINE_MS = 50;

/**
 * Entries taken from a DIRECTORY-shaped target path, non-recursively.
 *
 * A tool that names a directory is saying "I operate in here"; its own entries
 * are the honest universe. Sixty-four is a blast-radius bound, not a guess
 * about directory sizes: past it the observation degrades to the entries it
 * did see, and the settled sweep remains the net for the rest.
 */
export const OBSERVED_TARGET_DIR_MAX_ENTRIES = 64;

/** Tracked files (read-guard + widget + open LSP docs) the sweep may hold. */
export const OBSERVED_TRACKED_MAX_FILES = 400;

/**
 * Files the settled sweep STATS in one turn before parking its cursor.
 *
 * Smaller than {@link OBSERVED_TRACKED_MAX_FILES} on purpose: coverage of the
 * whole tracked set is spread across turns rather than attempted (and timed
 * out) in one. The read-guard's own set is ordered first by
 * `collectTrackedPaths`, so the files the agent is actually working on are at
 * the front of the rotation.
 */
export const OBSERVED_SWEEP_STAT_WINDOW = 128;

/** Cumulative content-hash budget for ONE capture. */
export const OBSERVED_HASH_BUDGET_BYTES = 2 * 1024 * 1024;

/** Cumulative bytes ONE settled sweep may read to seed or verify a hash. */
export const OBSERVED_SWEEP_HASH_BUDGET_BYTES = 2 * 1024 * 1024;

/** Cumulative bytes ONE settled sweep may read to derive edit RANGES. */
export const OBSERVED_SWEEP_RANGE_BUDGET_BYTES = 1024 * 1024;

/** Largest file whose per-line hashes are captured for range derivation. */
export const OBSERVED_LINE_HASH_MAX_BYTES = 512 * 1024;

/** Ranges reported per file before they collapse to one bounding box. */
export const OBSERVED_MAX_EDIT_RANGES = 32;

/** Pending baselines held between `tool_call` and `tool_result`. */
export const OBSERVED_PENDING_MAX = 32;

/** Files remembered by the settled-sweep content ledger. */
export const OBSERVED_LEDGER_MAX = 1000;

/** The replay payload, structurally identical to `MutationBridgeEntry`. */
export interface ObservedReplayEntry {
	filePath: string;
	kind: "edit";
	touchedLines?: [number, number];
	editRanges?: [number, number][];
	consumer?: string;
	provenance?: "observed" | "settled-sweep";
}

/** How a caller hands an observed change back to the pipeline. */
export type ObservedReplayRecorder = (entry: ObservedReplayEntry) => boolean;

interface PendingObservation {
	toolName: string;
	startedAt: number;
	cwd: string | undefined;
	sessionGeneration: number;
	/** The exact input list, so a file CREATED by the call still appears. */
	paths: string[];
	stats: FileStatsSnapshot;
	targetKey: string;
	targetLineHashes: Map<number, string> | undefined;
}

/**
 * Which hash space a ledger entry's `hash` lives in.
 *
 * `"content"` is the sha256 of the file's bytes. `"lines"` is a digest of the
 * read-guard's stored per-line hashes (#505) — pi-lens already paid for those
 * bytes on the read, so seeding from them costs the sweep no file read at all.
 * The two are NEVER compared to each other: a verify against a `"lines"`
 * baseline recomputes the lines digest from the current bytes.
 */
type LedgerHashKind = "content" | "lines";

interface LedgerEntry {
	hash: string | undefined;
	hashKind: LedgerHashKind | undefined;
	size: number;
	mtimeMs: number;
	/**
	 * When this entry was recorded — the guard on the stat short-circuit.
	 *
	 * "Stat first, read only on change" is what makes the sweep affordable, and
	 * its one blind spot is the classic same-tick same-size rewrite (catalog
	 * shape 6): a file rewritten to the same length inside the same
	 * filesystem mtime tick we last looked at it in looks untouched forever,
	 * because the drift is baked into the baseline. Comparing the observation
	 * time against the file's mtime closes it: an entry recorded while the
	 * file's mtime was still fresh cannot be trusted to short-circuit, so the
	 * next pass verifies it by content. Once the file stops being written the
	 * gap widens past the tolerance and the reads stop.
	 */
	seenAtMs: number;
}

interface ObservedNetState {
	pending: Map<string, PendingObservation>;
	ledger: Map<string, LedgerEntry>;
	/** Path keys already recorded through the pipeline this run. */
	handled: Set<string>;
	turnIndex: number;
	turnSpentMs: number;
	/** Where the next settled sweep resumes its rotation over the tracked set. */
	sweepCursor: number;
}

const OBSERVED_FAMILY = "observed-mutation-net";
const OBSERVED_VERSION = 2;

function state(): ObservedNetState {
	return getProcessSingleton<ObservedNetState>(
		OBSERVED_FAMILY,
		OBSERVED_VERSION,
		() => ({
			pending: new Map(),
			ledger: new Map(),
			handled: new Set(),
			turnIndex: -1,
			turnSpentMs: 0,
			sweepCursor: 0,
		}),
	);
}

/**
 * Session boundary (#2430). Pending baselines are keyed by tool-call id and
 * are unreachable once the session generation advances; the content ledger and
 * the handled set describe a finished session's files. All of it must clear or
 * a resumed session diffs against another session's world.
 */
export function resetObservedMutationNet(): void {
	const current = state();
	current.pending.clear();
	current.ledger.clear();
	current.handled.clear();
	current.turnIndex = -1;
	current.turnSpentMs = 0;
	current.sweepCursor = 0;
}

/** Test seam: the net's live state, as plain data. */
export function _observedMutationStateForTests(): {
	pending: string[];
	ledger: string[];
	handled: string[];
	turnSpentMs: number;
	sweepCursor: number;
} {
	const current = state();
	return {
		pending: [...current.pending.keys()],
		ledger: [...current.ledger.keys()],
		handled: [...current.handled],
		turnSpentMs: current.turnSpentMs,
		sweepCursor: current.sweepCursor,
	};
}

/**
 * Remember that the normal pipeline already recorded this path this run, so the
 * settled sweep refreshes its baseline instead of reporting the same bytes a
 * second time. Called from the classified `tool_result` path and from
 * `recordMutationThroughSeam`, which is every in-process producer.
 */
export function noteMutationHandled(filePath: string): void {
	try {
		state().handled.add(normalizeMapKey(path.resolve(filePath)));
	} catch {
		// A path that cannot be resolved cannot collide with a ledger key either.
	}
}

/**
 * Whether a `tool_result` has a baseline waiting for it.
 *
 * SYNCHRONOUS, and the first thing the `tool_result` seam asks (#2449 review
 * round 2, F1). The previous cut awaited the settle unconditionally, so every
 * tool_result — including the overwhelming majority that miss this map —
 * yielded a microtask before `handleToolResult` reached its debounce and
 * in-flight registration, breaking the #1086 ordering contract.
 */
export function hasPendingObservation(toolCallId: string | undefined): boolean {
	return toolCallId !== undefined && state().pending.has(toolCallId);
}

function remainingTurnBudgetMs(turnIndex: number): number {
	const current = state();
	if (current.turnIndex !== turnIndex) {
		current.turnIndex = turnIndex;
		current.turnSpentMs = 0;
	}
	return Math.max(0, OBSERVED_TURN_BUDGET_MS - current.turnSpentMs);
}

function chargeTurnBudget(turnIndex: number, spentMs: number): void {
	const current = state();
	if (current.turnIndex !== turnIndex) {
		current.turnIndex = turnIndex;
		current.turnSpentMs = 0;
	}
	current.turnSpentMs += Math.max(0, spentMs);
}

/** Test seam: force the per-turn budget to a known state. */
export function _setObservedTurnBudgetForTests(
	turnIndex: number,
	spentMs: number,
): void {
	const current = state();
	current.turnIndex = turnIndex;
	current.turnSpentMs = spentMs;
}

type BoundedOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "timeout" | "aborted" | "failed" };

/**
 * Both bounds on one async step: a wall-clock timeout AND an abort race.
 *
 * A loser is DISCARDED, never awaited to completion — the underlying work is
 * stat/read only, so letting it finish unobserved costs nothing, while awaiting
 * it would defeat the bound this exists to enforce. The timer is cleared on
 * every settle path so it cannot outlive the call (catalog shape 4).
 */
async function withBounds<T>(
	work: () => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<BoundedOutcome<T>> {
	if (signal?.aborted === true) return { ok: false, reason: "aborted" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const bound = new Promise<BoundedOutcome<T>>((resolve) => {
			timer = setTimeout(
				() => resolve({ ok: false, reason: "timeout" }),
				timeoutMs,
			);
			if (typeof timer.unref === "function") timer.unref();
			if (signal) {
				onAbort = () => resolve({ ok: false, reason: "aborted" });
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		return await Promise.race([
			work().then((value): BoundedOutcome<T> => ({ ok: true, value })),
			bound,
		]);
	} catch {
		// A THROW gets its own reason. Folding it into `timeout` is exactly the
		// misclassification catalog shape 10 warns about: a reader tuning the
		// budget would be chasing a bug that has nothing to do with time.
		return { ok: false, reason: "failed" };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** `splitLines` semantics from `read-guard.ts`, kept identical on purpose. */
function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/**
 * A cumulative byte allowance shared across a loop of line-hash reads.
 *
 * `deriveObservedEditRanges` reads whole files. On the settle path that is ONE
 * file; on the settled sweep it is once per drifted file, which without a
 * cumulative cap is an unbounded read volume at a turn boundary (#2449 review
 * round 2, F8). The caller creates one budget per pass and every read draws
 * from it.
 */
export interface LineHashReadBudget {
	remainingBytes: number;
}

function captureLineHashes(
	filePath: string,
	budget?: LineHashReadBudget,
): Map<number, string> | undefined {
	try {
		const size = fs.statSync(filePath).size;
		if (size > OBSERVED_LINE_HASH_MAX_BYTES) return undefined;
		if (budget) {
			if (budget.remainingBytes < size) return undefined;
			budget.remainingBytes -= size;
		}
		const lines = splitLines(fs.readFileSync(filePath, "utf-8"));
		const hashes = new Map<number, string>();
		for (let index = 0; index < lines.length; index += 1) {
			hashes.set(index + 1, lineContentHash(lines[index] ?? ""));
		}
		return hashes;
	} catch {
		return undefined;
	}
}

/**
 * A baseline's per-line hashes as a dense 1..N array, or `undefined` when it
 * does not cover the whole file.
 *
 * The read-guard stores hashes for the lines a read actually SHOWED, so a
 * windowed read's map covers a slice (say lines 60..100) and says nothing at
 * all about the rest. Treating that as a whole-file baseline is what made the
 * first cut drop a real change at line 3 and report a fabricated 61..101 range
 * (#2449 review round 2, F6). A baseline is usable only when its keys are
 * exactly 1..N.
 */
function denseLineBaseline(
	before: Map<number, string> | Record<number, string> | undefined,
): string[] | undefined {
	if (before === undefined) return undefined;
	const entries: Array<[number, string]> =
		before instanceof Map
			? [...before.entries()]
			: Object.entries(before).map(([line, hash]) => [Number(line), hash]);
	const count = entries.length;
	if (count === 0) return undefined;
	const ordered = new Array<string | undefined>(count);
	for (const [line, hash] of entries) {
		if (!Number.isInteger(line) || line < 1 || line > count) return undefined;
		ordered[line - 1] = hash;
	}
	for (const value of ordered) if (value === undefined) return undefined;
	return ordered as string[];
}

/**
 * Line ranges that actually differ, from the same FNV-1a whitespace-stripped
 * per-line hash the read-guard stores for every read (#505). `before` is the
 * pre-call capture when the net armed one, and otherwise the read-guard's own
 * stored hashes for the file — the issue's "content diff against the
 * read-guard's stored content".
 *
 * Returns `undefined` — meaning "no ranges, over-approximate to the whole
 * file" — whenever a per-line comparison would be a fabrication rather than a
 * measurement:
 *
 * - no baseline at all;
 * - a PARTIAL (windowed) baseline, which knows nothing about the lines outside
 *   its window;
 * - a changed LINE COUNT, where every line after an insert or delete shifts and
 *   comparing by line number reports the shift instead of the edit;
 * - a file too large to hash, or a spent read budget.
 *
 * Every one of those is the safe direction: the bridge's `resolveChangedRange`
 * then over-approximates to the whole file rather than naming lines that were
 * never touched.
 */
export function deriveObservedEditRanges(
	filePath: string,
	before: Map<number, string> | Record<number, string> | undefined,
	budget?: LineHashReadBudget,
): [number, number][] | undefined {
	const baseline = denseLineBaseline(before);
	if (baseline === undefined) return undefined;
	const after = captureLineHashes(filePath, budget);
	if (after === undefined) return undefined;
	if (after.size !== baseline.length) return undefined;
	const changed: number[] = [];
	for (let line = 1; line <= baseline.length; line += 1) {
		if (after.get(line) !== baseline[line - 1]) changed.push(line);
	}
	if (changed.length === 0) return undefined;
	const ranges: [number, number][] = [];
	let start = changed[0];
	let end = changed[0];
	for (const line of changed.slice(1)) {
		if (line === end + 1) {
			end = line;
			continue;
		}
		ranges.push([start, end]);
		start = line;
		end = line;
	}
	ranges.push([start, end]);
	if (ranges.length > OBSERVED_MAX_EDIT_RANGES) {
		// A rewrite this scattered is a whole-file change in practice; one
		// bounding box keeps the record bounded (AGENTS.md bounded-record rule).
		return [[ranges[0][0], ranges[ranges.length - 1][1]]];
	}
	return ranges;
}

function boundingBox(ranges: [number, number][]): [number, number] {
	return [
		Math.min(...ranges.map(([start]) => start)),
		Math.max(...ranges.map(([, end]) => end)),
	];
}

function putPending(key: string, value: PendingObservation): void {
	const pending = state().pending;
	if (!pending.has(key) && pending.size >= OBSERVED_PENDING_MAX) {
		const oldest = pending.keys().next().value;
		if (oldest !== undefined) pending.delete(oldest);
	}
	pending.set(key, value);
}

function putLedger(key: string, value: LedgerEntry): void {
	const ledger = state().ledger;
	if (!ledger.has(key) && ledger.size >= OBSERVED_LEDGER_MAX) {
		const oldest = ledger.keys().next().value;
		if (oldest !== undefined) ledger.delete(oldest);
	}
	ledger.set(key, value);
}

function seedLedger(snapshot: FileStatsSnapshot): void {
	const seenAtMs = Date.now();
	for (const [key, entry] of snapshot) {
		putLedger(key, {
			hash: entry.hash,
			hashKind: entry.hash === undefined ? undefined : "content",
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			seenAtMs,
		});
	}
}

function linesDigest(ordered: string[]): string {
	return createHash("sha256").update(ordered.join("\n")).digest("hex");
}

function linesDigestOfContent(content: string): string {
	return linesDigest(splitLines(content).map((line) => lineContentHash(line)));
}

export interface ArmObservationArgs {
	toolCallId: string | undefined;
	toolName: string;
	/** Resolved absolute path the tool named. */
	targetPath: string;
	cwd: string | undefined;
	sessionGeneration: number;
	turnIndex: number;
	signal?: AbortSignal;
	dbg?: (msg: string) => void;
}

export type ArmObservationResult =
	| { armed: true; scannedCount: number; durationMs: number }
	| {
			armed: false;
			reason:
				| "not-eligible"
				| "no-tool-call-id"
				| "budget-exhausted"
				| "timeout"
				| "aborted"
				| "failed";
	  };

/**
 * Take the pre-call baseline for an unclassified tool call.
 *
 * Cost on a call this does NOT arm is one `Map` lookup — the eligibility check
 * runs before any filesystem work, so a classified tool never reaches here at
 * all and a latched tool stops after the lookup.
 */
export async function armObservedMutation(
	args: ArmObservationArgs,
): Promise<ArmObservationResult> {
	if (!shouldArmObservationForTool(args.toolName))
		return { armed: false, reason: "not-eligible" };
	if (!args.toolCallId) return { armed: false, reason: "no-tool-call-id" };

	const remaining = remainingTurnBudgetMs(args.turnIndex);
	if (remaining <= 0) {
		emitBounded(
			"observed_mutation_budget_exhausted",
			args.toolName,
			{
				filePath: args.targetPath,
				durationMs: 0,
				result: `turn-budget:${OBSERVED_TURN_BUDGET_MS}ms`,
			},
			{
				ledgerKind: "observed-mutation-budget",
				reason: "per-turn observational snapshot budget exhausted",
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
		return { armed: false, reason: "budget-exhausted" };
	}

	const started = Date.now();
	const timeoutMs = Math.min(remaining, OBSERVED_CAPTURE_BUDGET_MS);
	const outcome = await withBounds(
		async () => {
			const paths = await collectObservationUniverse(args.targetPath);
			const stats = await captureFileStatsForPaths(paths, {
				withHashes: true,
				hashBudgetBytes: OBSERVED_HASH_BUDGET_BYTES,
			});
			return { paths, stats };
		},
		timeoutMs,
		args.signal,
	);
	chargeTurnBudget(args.turnIndex, Date.now() - started);

	if (!outcome.ok) {
		emitBounded(
			"observed_mutation_budget_exhausted",
			args.toolName,
			{
				filePath: args.targetPath,
				durationMs: Date.now() - started,
				result: outcome.reason,
			},
			{
				ledgerKind: "observed-mutation-budget",
				reason: `observational pre-snapshot ${outcome.reason}`,
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
		return { armed: false, reason: outcome.reason };
	}

	const targetKey = normalizeMapKey(path.resolve(args.targetPath));
	seedLedger(outcome.value.stats);
	putPending(args.toolCallId, {
		toolName: args.toolName,
		startedAt: started,
		cwd: args.cwd,
		sessionGeneration: args.sessionGeneration,
		paths: outcome.value.paths,
		stats: outcome.value.stats,
		targetKey,
		targetLineHashes: captureLineHashes(args.targetPath),
	});
	const durationMs = Date.now() - started;
	logLatency({
		type: "phase",
		toolName: args.toolName,
		phase: "observed_mutation_prescan",
		filePath: args.targetPath,
		durationMs,
		result: `scanned:${outcome.value.stats.size}`,
	});
	return { armed: true, scannedCount: outcome.value.stats.size, durationMs };
}

/**
 * The snapshot universe: the TARGET PATH, and nothing else.
 *
 * A file target is itself. A DIRECTORY target is its own entries,
 * non-recursively and capped — a tool naming a directory is claiming that
 * directory as its working set. A path that does not exist yet is still
 * watched as itself, so a call that CREATES it is observed.
 *
 * See the module header for why the sibling walk and the tracked-set fold this
 * replaces were both wrong.
 */
async function collectObservationUniverse(
	targetPath: string,
): Promise<string[]> {
	const target = path.resolve(targetPath);
	try {
		const stat = await fs.promises.stat(target);
		if (stat.isDirectory()) {
			const entries = await fs.promises.readdir(target, {
				withFileTypes: true,
			});
			const files: string[] = [];
			for (const entry of entries) {
				if (files.length >= OBSERVED_TARGET_DIR_MAX_ENTRIES) break;
				if (entry.isFile()) files.push(path.join(target, entry.name));
			}
			return files;
		}
	} catch {
		// Does not exist yet, or is unreadable. Watching the path itself is the
		// right answer for both: a call that creates it shows up as an addition.
	}
	return [target];
}

export interface SettleObservationArgs {
	toolCallId: string | undefined;
	toolName: string;
	sessionGeneration: number;
	turnIndex: number;
	signal?: AbortSignal;
	record: ObservedReplayRecorder;
	/** Read-guard read history for a file, for range derivation without a baseline. */
	getStoredLineHashes?: (
		filePath: string,
	) => Record<number, string> | undefined;
	isRecordable?: (filePath: string) => boolean;
	dbg?: (msg: string) => void;
}

export interface SettleObservationResult {
	settled: boolean;
	changedPaths: string[];
	replayed: number;
	/** Entries actually re-captured. Short of the baseline means a cut capture. */
	scanned: number;
	/** Present whenever `settled` is false, or the capture was cut short. */
	reason?: string;
}

/**
 * Diff the post-call state against the baseline and replay what changed.
 *
 * A change here is the FIRST-CALL coverage #2430's first acceptance criterion
 * asks for: the tool is unknown, so nothing downstream would have recorded the
 * file, and this replay is what puts it in `turn-state.json`.
 *
 * SYNCHRONOUS by contract. `handleToolResult` may not yield before dispatching
 * the pipeline (#1086); an `await` here — even on the map-miss path, which is
 * almost every call — reordered the debounce and in-flight registration and
 * reds `tests/clients/runtime-tool-result-debounce.test.ts` (#2449 round 2,
 * F1). Callers gate on {@link hasPendingObservation} first, so reaching this
 * function at all already means there is real work to do.
 *
 * NOT budget-gated. The previous cut clamped the post-capture to whatever was
 * left of the per-turn arm budget, which on a busy turn is 1ms — long enough to
 * stat nothing and report a timeout, dropping a mutation that had already been
 * measured (round 2, F5). The baseline exists; re-capturing the target it was
 * taken for is not optional.
 */
export function settleObservedMutation(
	args: SettleObservationArgs,
): SettleObservationResult {
	const key = args.toolCallId;
	if (!key)
		return {
			settled: false,
			changedPaths: [],
			replayed: 0,
			scanned: 0,
			reason: "no-tool-call-id",
		};
	const pending = state().pending.get(key);
	if (!pending) {
		// A missing baseline is a real answer, not a no-op: the arm was evicted
		// by the pending cap, or never ran. Saying so keeps "nothing changed"
		// distinguishable from "nothing was watched" (catalog shape 10).
		return {
			settled: false,
			changedPaths: [],
			replayed: 0,
			scanned: 0,
			reason: "no-pending-baseline",
		};
	}
	state().pending.delete(key);
	if (pending.sessionGeneration !== args.sessionGeneration) {
		// Catalog shape 22: the baseline belongs to a session that has since
		// ended. Diffing across that boundary would attribute another session's
		// world to this call.
		return {
			settled: false,
			changedPaths: [],
			replayed: 0,
			scanned: 0,
			reason: "session-generation-advanced",
		};
	}

	const started = Date.now();
	// The target is `paths[0]` for a file target and the whole (already capped)
	// entry list for a directory one. The deadline can only ever cut a directory
	// target's tail — `captureFileStatsForPathsSync` always runs its first entry.
	const captured = captureFileStatsForPathsSync(pending.paths, {
		withHashes: true,
		hashBudgetBytes: OBSERVED_HASH_BUDGET_BYTES,
		deadlineMs: started + OBSERVED_SETTLE_DEADLINE_MS,
		signal: args.signal,
	});
	chargeTurnBudget(args.turnIndex, Date.now() - started);

	seedLedger(captured.snapshot);
	const changed = diffFileStats(pending.stats, captured.snapshot).filter(
		(candidate) => args.isRecordable?.(candidate) !== false,
	);
	const cutReason = captured.stoppedEarly ? "capture-cut-short" : undefined;
	if (changed.length === 0) {
		// A CUT capture is not evidence of cleanliness — it is evidence we
		// stopped looking. Advancing the clean latch on it would teach pi-lens
		// to stop watching a tool it never finished watching.
		if (!captured.stoppedEarly) noteObservedClean(args.toolName);
		return {
			settled: true,
			changedPaths: [],
			replayed: 0,
			scanned: captured.snapshot.size,
			reason: cutReason,
		};
	}

	const rangeBudget: LineHashReadBudget = {
		remainingBytes: OBSERVED_HASH_BUDGET_BYTES,
	};
	let replayed = 0;
	for (const filePath of changed) {
		const baseline =
			filePath === pending.targetKey
				? pending.targetLineHashes
				: args.getStoredLineHashes?.(filePath);
		const editRanges = deriveObservedEditRanges(
			filePath,
			baseline,
			rangeBudget,
		);
		const accepted = args.record({
			filePath,
			kind: "edit",
			touchedLines: editRanges ? boundingBox(editRanges) : undefined,
			editRanges: editRanges && editRanges.length > 1 ? editRanges : undefined,
			consumer: args.toolName,
			provenance: "observed",
		});
		if (accepted) {
			replayed += 1;
			noteMutationHandled(filePath);
		}
	}
	if (replayed > 0) {
		// The universe IS the target path, so a replay here means the tool
		// changed what it named — never a sibling that happened to move
		// underneath it (#2449 round 2, F4).
		const attribution = noteObservedMutation(args.toolName, pending.cwd);
		logLatency({
			type: "phase",
			toolName: args.toolName,
			phase: "observed_mutation_recovered",
			filePath: changed.slice(0, 5).join(","),
			durationMs: Date.now() - started,
			result: `changed:${changed.length} observations:${attribution.observations}${
				attribution.persisted ? " persisted" : ""
			}`,
		});
	} else {
		// Every candidate was refused by the recorder (out of scope, or the
		// bookkeeping failed). That is not evidence the tool is clean, so the
		// clean latch is deliberately NOT advanced here.
		logLatency({
			type: "phase",
			toolName: args.toolName,
			phase: "observed_mutation_coverage_unknown",
			filePath: changed.slice(0, 5).join(","),
			durationMs: Date.now() - started,
			result: `refused:${changed.length}`,
		});
	}
	return {
		settled: true,
		changedPaths: changed,
		replayed,
		scanned: captured.snapshot.size,
		reason: cutReason,
	};
}

export interface SettledSweepArgs {
	turnIndex: number;
	getTrackedPaths: () => string[];
	record: ObservedReplayRecorder;
	getStoredLineHashes?: (
		filePath: string,
	) => Record<number, string> | undefined;
	isRecordable?: (filePath: string) => boolean;
	signal?: AbortSignal;
	dbg?: (msg: string) => void;
}

export interface SettledSweepResult {
	/** Files stat'ed this pass. */
	scanned: number;
	/** Tracked files this pass did NOT reach; the cursor resumes there. */
	remaining: number;
	/** Where the next pass resumes. */
	cursor: number;
	drifted: string[];
	/**
	 * Files whose stat moved but whose content could not be proven changed —
	 * too large to hash, or no hashed baseline yet. Named rather than replayed
	 * (#2449 round 2, F7), because a `touch` moves mtime without moving a byte.
	 */
	unverifiable: string[];
	replayed: number;
	reason?: string;
}

type DriftVerdict = "drift" | "clean" | "unverifiable";

interface IncrementalScanOutcome {
	scanned: number;
	tracked: number;
	cursor: number;
	drifted: string[];
	unverifiable: string[];
	stoppedEarly: boolean;
}

async function readBytesSafe(filePath: string): Promise<Buffer | undefined> {
	try {
		return await fs.promises.readFile(filePath);
	} catch {
		return undefined;
	}
}

/**
 * One incremental pass over the tracked set (#2449 round 2, F3).
 *
 * The shape that makes this affordable: **stat first, read only on change.**
 * A file whose size and mtime match the ledger costs one `stat` and nothing
 * else, which is the steady state for almost every file on almost every turn.
 * A file whose stat moved is the only one worth reading, and that read is what
 * separates a real edit from a `touch`.
 *
 * A first sighting prefers the read-guard's stored per-line hashes over a file
 * read: #505 already paid for those bytes, so seeding a file the agent has read
 * costs no I/O beyond the stat it already did.
 *
 * `report: false` is the post-drain re-baseline — same traversal, whole set,
 * nothing reported.
 */
async function scanTrackedIncrementally(
	args: Pick<
		SettledSweepArgs,
		"getTrackedPaths" | "signal" | "getStoredLineHashes" | "isRecordable"
	>,
	options: { report: boolean; deadlineMs: number },
): Promise<IncrementalScanOutcome> {
	const current = state();
	let tracked: string[];
	try {
		tracked = args.getTrackedPaths().slice(0, OBSERVED_TRACKED_MAX_FILES);
	} catch {
		tracked = [];
	}
	const total = tracked.length;
	if (total === 0) {
		current.sweepCursor = 0;
		return {
			scanned: 0,
			tracked: 0,
			cursor: 0,
			drifted: [],
			unverifiable: [],
			stoppedEarly: false,
		};
	}

	const startCursor = options.report
		? ((current.sweepCursor % total) + total) % total
		: 0;
	const window = options.report
		? Math.min(OBSERVED_SWEEP_STAT_WINDOW, total)
		: total;
	let hashBytesLeft = OBSERVED_SWEEP_HASH_BUDGET_BYTES;
	const drifted: string[] = [];
	const unverifiable: string[] = [];
	let scanned = 0;
	let stoppedEarly = false;
	let steps = 0;

	for (; steps < window; steps += 1) {
		if (args.signal?.aborted === true) {
			stoppedEarly = true;
			break;
		}
		if (Date.now() >= options.deadlineMs) {
			stoppedEarly = true;
			break;
		}
		const filePath = tracked[(startCursor + steps) % total];
		let key: string;
		try {
			key = normalizeMapKey(path.resolve(filePath));
		} catch {
			continue;
		}
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(filePath);
		} catch {
			// Gone, or unreadable. Deletions are not this net's business.
			scanned += 1;
			continue;
		}
		if (!stat.isFile()) {
			scanned += 1;
			continue;
		}
		scanned += 1;

		const previous = current.ledger.get(key);
		const next: LedgerEntry = {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			hash: previous?.hash,
			hashKind: previous?.hashKind,
			seenAtMs: Date.now(),
		};

		if (previous === undefined) {
			const dense = denseLineBaseline(args.getStoredLineHashes?.(key));
			if (dense) {
				next.hash = linesDigest(dense);
				next.hashKind = "lines";
			} else if (stat.size <= hashBytesLeft) {
				const content = await readBytesSafe(filePath);
				if (content !== undefined) {
					hashBytesLeft -= stat.size;
					next.hash = createHash("sha256").update(content).digest("hex");
					next.hashKind = "content";
				}
			}
			putLedger(key, next);
			continue;
		}

		// The stat short-circuit — the reason this pass is affordable — but only
		// when the baseline is old enough to be trusted. See `LedgerEntry.seenAtMs`
		// for the same-tick same-size rewrite it would otherwise bake in forever.
		if (
			previous.size === stat.size &&
			previous.mtimeMs === stat.mtimeMs &&
			previous.seenAtMs - stat.mtimeMs > OPAQUE_MTIME_TOLERANCE_MS
		) {
			putLedger(key, next);
			continue;
		}

		// A drift CANDIDATE. Size moving is proof on its own; mtime moving is
		// NOT (a `touch` bumps it without a byte moving), so mtime-only drift
		// has to be confirmed against content before anything is replayed
		// (#2449 round 2, F7).
		const sizeChanged = previous.size !== stat.size;
		let verdict: DriftVerdict = sizeChanged ? "drift" : "unverifiable";
		if (stat.size <= hashBytesLeft) {
			const content = await readBytesSafe(filePath);
			if (content !== undefined) {
				hashBytesLeft -= stat.size;
				const contentHash = createHash("sha256").update(content).digest("hex");
				if (previous.hash === undefined) {
					verdict = sizeChanged ? "drift" : "unverifiable";
				} else if (previous.hashKind === "lines") {
					verdict =
						linesDigestOfContent(content.toString("utf-8")) !== previous.hash
							? "drift"
							: "clean";
				} else {
					verdict = contentHash !== previous.hash ? "drift" : "clean";
				}
				// Store the CONTENT hash either way, so the next change to this
				// file is verifiable even if this one was not.
				next.hash = contentHash;
				next.hashKind = "content";
			}
		}
		putLedger(key, next);

		if (!options.report) continue;
		if (current.handled.has(key)) continue;
		if (args.isRecordable?.(key) === false) continue;
		if (verdict === "drift") drifted.push(key);
		else if (verdict === "unverifiable") unverifiable.push(key);
	}

	if (options.report) current.sweepCursor = (startCursor + steps) % total;
	return {
		scanned,
		tracked: total,
		cursor: options.report ? current.sweepCursor : 0,
		drifted,
		unverifiable,
		stoppedEarly,
	};
}

/**
 * The turn-boundary net (#2430 item 3), run at `agent_settled` BEFORE the
 * deferred drain so anything it finds is formatted in the same settle.
 *
 * Files the pipeline already recorded this run refresh their baseline and are
 * never reported twice. Coverage is incremental and self-reported: see
 * {@link scanTrackedIncrementally} and {@link SettledSweepResult}.
 */
export async function runObservedSettledSweep(
	args: SettledSweepArgs,
): Promise<SettledSweepResult> {
	const started = Date.now();
	const outcome = await withBounds(
		() =>
			scanTrackedIncrementally(args, {
				report: true,
				deadlineMs: started + OBSERVED_CAPTURE_BUDGET_MS,
			}),
		// The inner loop parks its own cursor at the deadline, so this outer
		// race exists only to bound a single wedged `stat` — hence the slack.
		OBSERVED_CAPTURE_BUDGET_MS * 2,
		args.signal,
	);
	if (!outcome.ok) {
		emitBounded(
			"observed_sweep_skipped_budget",
			"settled-sweep",
			{ durationMs: Date.now() - started, result: outcome.reason },
			{
				ledgerKind: "observed-mutation-budget",
				reason: `settled sweep ${outcome.reason}`,
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
		return {
			scanned: 0,
			remaining: 0,
			cursor: state().sweepCursor,
			drifted: [],
			unverifiable: [],
			replayed: 0,
			reason: outcome.reason,
		};
	}

	const scan = outcome.value;
	const rangeBudget: LineHashReadBudget = {
		remainingBytes: OBSERVED_SWEEP_RANGE_BUDGET_BYTES,
	};
	let replayed = 0;
	for (const filePath of scan.drifted) {
		if (args.signal?.aborted === true) break;
		const editRanges = deriveObservedEditRanges(
			filePath,
			args.getStoredLineHashes?.(filePath),
			rangeBudget,
		);
		const accepted = args.record({
			filePath,
			kind: "edit",
			touchedLines: editRanges ? boundingBox(editRanges) : undefined,
			editRanges: editRanges && editRanges.length > 1 ? editRanges : undefined,
			consumer: "settled-sweep",
			provenance: "settled-sweep",
		});
		if (accepted) replayed += 1;
	}
	const remaining = Math.max(0, scan.tracked - scan.scanned);
	if (scan.drifted.length > 0 || scan.unverifiable.length > 0) {
		logLatency({
			type: "phase",
			phase: "observed_settled_sweep_drift",
			filePath: scan.drifted.slice(0, 5).join(","),
			durationMs: Date.now() - started,
			result: `drifted:${scan.drifted.length} replayed:${replayed} unverifiable:${scan.unverifiable.length} scanned:${scan.scanned}/${scan.tracked} cursor:${scan.cursor}`,
		});
	}
	if (scan.unverifiable.length > 0) {
		// Named, capped, and never replayed: a stat that moved without a
		// provable content change is a gap in coverage, and a gap that reports
		// itself is the only kind that gets fixed (catalog shape 10).
		emitBounded(
			"observed_sweep_unverifiable",
			"settled-sweep",
			{
				durationMs: Date.now() - started,
				result: `unverifiable:${scan.unverifiable.length}`,
				filePath: scan.unverifiable.slice(0, 5).join(","),
			},
			{
				ledgerKind: "observed-mutation-budget",
				reason:
					"tracked file's size/mtime moved but no hashed baseline could confirm a content change",
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
	}
	return {
		scanned: scan.scanned,
		remaining,
		cursor: scan.cursor,
		drifted: scan.drifted,
		unverifiable: scan.unverifiable,
		replayed,
		reason: scan.stoppedEarly ? "window-parked" : undefined,
	};
}

/**
 * Re-baseline the tracked set AFTER the deferred drain.
 *
 * The drain is pi-lens formatting and autofixing files it already knows about,
 * so those bytes are ours. Without this the next settle would read them as
 * third-party drift and requeue the same files forever.
 *
 * Same traversal as the sweep, so the same "stat first, read only on change"
 * cost applies: the drain touches a handful of files, and only those are read.
 * Clearing `handled` is this function's job and not the sweep's — the sweep
 * runs BEFORE the drain, so a set cleared there would not cover the drain's own
 * writes.
 */
export async function refreshObservedMutationLedger(
	args: Pick<
		SettledSweepArgs,
		"getTrackedPaths" | "signal" | "getStoredLineHashes"
	>,
): Promise<number> {
	const started = Date.now();
	const outcome = await withBounds(
		() =>
			scanTrackedIncrementally(args, {
				report: false,
				deadlineMs: started + OBSERVED_CAPTURE_BUDGET_MS,
			}),
		OBSERVED_CAPTURE_BUDGET_MS * 2,
		args.signal,
	);
	state().handled.clear();
	return outcome.ok ? outcome.value.scanned : 0;
}
