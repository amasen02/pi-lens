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
 * tool is then ATTRIBUTED (`clients/mutation-attribution.ts`), so the second
 * call is classified by name with no snapshot at all and a later session on the
 * same project classifies it from disk.
 *
 * Three layers, cheapest first:
 *
 * 1. **Nothing at all** for a tool the seam already classifies. `arm` is never
 *    reached: `runtime-tool-call.ts` only calls in when `classifyMutatingTool`
 *    returned `undefined`, and the first thing `arm` does is a map lookup.
 * 2. **Arm + diff** for an unclassified call whose input carries a path-shaped
 *    field, bounded to that path's DIRECTORY plus the tracked-file set. Paid at
 *    most twice per tool name per session (see `CLEAN_OBSERVATION_ARM_LIMIT`).
 * 3. **The settled sweep** at `agent_settled`, before the deferred drain, for
 *    tools with no path field at all. It hash-checks the tracked-file set —
 *    read-guard reads and writes, widget diagnostic files, open LSP documents —
 *    and NEVER walks the workspace.
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
 * ## Bounds (AGENTS.md async rule, both directions)
 *
 * Every async step here carries a TIMEOUT and an `AbortSignal` race, and every
 * capture is additionally bounded by a file cap and a hash-byte budget. The
 * whole net shares a PER-TURN wall-clock budget; exhausting it emits a bounded
 * `observed_mutation_budget_exhausted` record and a degradation-ledger tally —
 * it is never a silent skip (catalog shape 10).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { emitBounded } from "./bounded-telemetry.js";
import { logLatency } from "./latency-logger.js";
import {
	noteObservedClean,
	noteObservedMutation,
	shouldArmObservationForTool,
} from "./mutation-attribution.js";
import {
	captureFileStatsForPaths,
	diffFileStats,
	type FileStatsSnapshot,
} from "./opaque-mutation-scan.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";
import { lineContentHash } from "./read-guard.js";
import { collectSourceFilesWithBudgetAsync } from "./source-filter.js";

/**
 * Wall-clock CEILING for ONE snapshot capture (arm or settle) — not its cost.
 *
 * Measured on this repo (Windows, warm page cache): the shared source walker's
 * FIRST call in a process costs ~92ms because it initializes the project ignore
 * matchers; every later call over the same small directory is ~1ms. The ceiling
 * has to clear that one-time warmup or the very first observation in a session
 * always reports a timeout, which is the least useful possible outcome — so it
 * is set above the cold number, and the steady-state cost is two orders of
 * magnitude below it.
 */
export const OBSERVED_CAPTURE_BUDGET_MS = 200;

/**
 * Cumulative ceiling for every observational capture in one turn. A turn that
 * calls twenty unclassified tools pays this once, not twenty times.
 */
export const OBSERVED_TURN_BUDGET_MS = 600;

/** Files kept from the target path's own directory walk. */
export const OBSERVED_DIR_MAX_FILES = 200;

/** Tracked files (read-guard + widget + open LSP docs) folded into a capture. */
export const OBSERVED_TRACKED_MAX_FILES = 400;

/** Cumulative content-hash budget for ONE capture. */
export const OBSERVED_HASH_BUDGET_BYTES = 2 * 1024 * 1024;

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

interface LedgerEntry {
	hash: string | undefined;
	size: number;
	mtimeMs: number;
}

interface ObservedNetState {
	pending: Map<string, PendingObservation>;
	ledger: Map<string, LedgerEntry>;
	/** Path keys already recorded through the pipeline this run. */
	handled: Set<string>;
	turnIndex: number;
	turnSpentMs: number;
}

const OBSERVED_FAMILY = "observed-mutation-net";
const OBSERVED_VERSION = 1;

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
		}),
	);
}

/**
 * Session boundary (#2430). Pending baselines are keyed by tool-call id and
 * are unreachable once the session generation advances; the content ledger and
 * the handled set describe a finished session's files. All three must clear or
 * a resumed session diffs against another session's world.
 */
export function resetObservedMutationNet(): void {
	const current = state();
	current.pending.clear();
	current.ledger.clear();
	current.handled.clear();
	current.turnIndex = -1;
	current.turnSpentMs = 0;
}

/** Test seam: the net's live state, as plain data. */
export function _observedMutationStateForTests(): {
	pending: string[];
	ledger: string[];
	handled: string[];
	turnSpentMs: number;
} {
	const current = state();
	return {
		pending: [...current.pending.keys()],
		ledger: [...current.ledger.keys()],
		handled: [...current.handled],
		turnSpentMs: current.turnSpentMs,
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

function captureLineHashes(filePath: string): Map<number, string> | undefined {
	try {
		if (fs.statSync(filePath).size > OBSERVED_LINE_HASH_MAX_BYTES)
			return undefined;
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
 * Line ranges that actually differ, from the same FNV-1a whitespace-stripped
 * per-line hash the read-guard stores for every read (#505). `before` is the
 * pre-call capture when the net armed one, and otherwise the read-guard's own
 * stored hashes for the file — the issue's "content diff against the
 * read-guard's stored content".
 *
 * Returns `undefined` when no baseline exists. The caller then records no
 * ranges at all, and the bridge's `resolveChangedRange` over-approximates to
 * the whole file, which is the safe direction.
 */
export function deriveObservedEditRanges(
	filePath: string,
	before: Map<number, string> | Record<number, string> | undefined,
): [number, number][] | undefined {
	if (before === undefined) return undefined;
	const baseline =
		before instanceof Map
			? before
			: new Map(
					Object.entries(before).map(([line, hash]) => [Number(line), hash]),
				);
	if (baseline.size === 0) return undefined;
	const after = captureLineHashes(filePath);
	if (after === undefined) return undefined;
	const changed: number[] = [];
	// Only lines the baseline actually covers can be compared. A partial read's
	// hashes cover a window, so lines outside it are UNKNOWN, not unchanged.
	const coveredMax = Math.max(...baseline.keys());
	const coveredMin = Math.min(...baseline.keys());
	for (const [line, hash] of after) {
		if (line < coveredMin) continue;
		if (line > coveredMax) {
			// Appended past the baseline window: real new content.
			changed.push(line);
			continue;
		}
		const previous = baseline.get(line);
		if (previous === undefined || previous !== hash) changed.push(line);
	}
	if (changed.length === 0) return undefined;
	changed.sort((a, b) => a - b);
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
	for (const [key, entry] of snapshot) {
		putLedger(key, {
			hash: entry.hash,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		});
	}
}

export interface ArmObservationArgs {
	toolCallId: string | undefined;
	toolName: string;
	/** Resolved absolute path the tool named. */
	targetPath: string;
	cwd: string | undefined;
	sessionGeneration: number;
	turnIndex: number;
	/** Read-guard reads/writes + widget files + open LSP documents. */
	getTrackedPaths: () => string[];
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
 * all and a latched-clean tool stops after the lookup.
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
			const paths = await collectObservationUniverse(args, timeoutMs);
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
 * The snapshot universe: the target path, everything under its own directory
 * (bounded, and routed through the shared source walker so project ignores and
 * excluded directories apply), and the tracked-file set. Never the workspace.
 */
async function collectObservationUniverse(
	args: ArmObservationArgs,
	budgetMs: number,
): Promise<string[]> {
	const universe = new Set<string>();
	universe.add(path.resolve(args.targetPath));
	try {
		const walk = await collectSourceFilesWithBudgetAsync(
			path.dirname(path.resolve(args.targetPath)),
			{ maxFiles: OBSERVED_DIR_MAX_FILES, budgetMs },
		);
		for (const file of walk.files) universe.add(path.resolve(file));
	} catch {
		// A directory that cannot be walked still leaves the target and the
		// tracked set observable; a partial universe is honest here because the
		// verdict this feeds is "these files changed", never "nothing else did".
	}
	let tracked = 0;
	for (const file of args.getTrackedPaths()) {
		if (tracked >= OBSERVED_TRACKED_MAX_FILES) break;
		try {
			universe.add(path.resolve(file));
			tracked += 1;
		} catch {
			// Unresolvable path: nothing to stat.
		}
	}
	return [...universe];
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
	reason?: string;
}

/**
 * Diff the post-call state against the baseline and replay what changed.
 *
 * A change here is the FIRST-CALL coverage #2430's first acceptance criterion
 * asks for: the tool is unknown, so nothing downstream would have recorded the
 * file, and this replay is what puts it in `turn-state.json`.
 */
export async function settleObservedMutation(
	args: SettleObservationArgs,
): Promise<SettleObservationResult> {
	const key = args.toolCallId;
	if (!key) return { settled: false, changedPaths: [], replayed: 0 };
	const pending = state().pending.get(key);
	if (!pending) return { settled: false, changedPaths: [], replayed: 0 };
	state().pending.delete(key);
	if (pending.sessionGeneration !== args.sessionGeneration) {
		// Catalog shape 22: the baseline belongs to a session that has since
		// ended. Diffing across that boundary would attribute another session's
		// world to this call.
		return {
			settled: false,
			changedPaths: [],
			replayed: 0,
			reason: "session-generation-advanced",
		};
	}

	const started = Date.now();
	const remaining = remainingTurnBudgetMs(args.turnIndex);
	const timeoutMs = Math.min(
		Math.max(remaining, 1),
		OBSERVED_CAPTURE_BUDGET_MS,
	);
	const outcome = await withBounds(
		() =>
			captureFileStatsForPaths(pending.paths, {
				withHashes: true,
				hashBudgetBytes: OBSERVED_HASH_BUDGET_BYTES,
			}),
		timeoutMs,
		args.signal,
	);
	chargeTurnBudget(args.turnIndex, Date.now() - started);
	if (!outcome.ok) {
		emitBounded(
			"observed_mutation_budget_exhausted",
			args.toolName,
			{
				durationMs: Date.now() - started,
				result: outcome.reason,
				filePath: pending.targetKey,
			},
			{
				ledgerKind: "observed-mutation-budget",
				reason: `observational post-snapshot ${outcome.reason}`,
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
		return {
			settled: false,
			changedPaths: [],
			replayed: 0,
			reason: outcome.reason,
		};
	}

	seedLedger(outcome.value);
	const changed = diffFileStats(pending.stats, outcome.value).filter(
		(candidate) => args.isRecordable?.(candidate) !== false,
	);
	if (changed.length === 0) {
		noteObservedClean(args.toolName);
		return { settled: true, changedPaths: [], replayed: 0 };
	}

	let replayed = 0;
	for (const filePath of changed) {
		const baseline =
			filePath === pending.targetKey
				? pending.targetLineHashes
				: args.getStoredLineHashes?.(filePath);
		const editRanges = deriveObservedEditRanges(filePath, baseline);
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
	return { settled: true, changedPaths: changed, replayed };
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
	scanned: number;
	drifted: string[];
	replayed: number;
	reason?: string;
}

async function sweepCapture(
	args: SettledSweepArgs,
): Promise<FileStatsSnapshot | { failed: "timeout" | "aborted" | "failed" }> {
	const paths = args.getTrackedPaths().slice(0, OBSERVED_TRACKED_MAX_FILES);
	if (paths.length === 0) return new Map();
	const outcome = await withBounds(
		() =>
			captureFileStatsForPaths(paths, {
				withHashes: true,
				hashBudgetBytes: OBSERVED_HASH_BUDGET_BYTES,
			}),
		OBSERVED_CAPTURE_BUDGET_MS,
		args.signal,
	);
	return outcome.ok ? outcome.value : { failed: outcome.reason };
}

function isDrift(previous: LedgerEntry, current: LedgerEntry): boolean {
	if (previous.hash !== undefined && current.hash !== undefined)
		return previous.hash !== current.hash;
	return previous.size !== current.size || previous.mtimeMs !== current.mtimeMs;
}

/**
 * The turn-boundary net (#2430 item 3), run at `agent_settled` BEFORE the
 * deferred drain so anything it finds is formatted in the same settle.
 *
 * Hash-checks the tracked-file set only. Files the pipeline already recorded
 * this run refresh their baseline and are never reported twice.
 */
export async function runObservedSettledSweep(
	args: SettledSweepArgs,
): Promise<SettledSweepResult> {
	const started = Date.now();
	const captured = await sweepCapture(args);
	if ("failed" in captured) {
		emitBounded(
			"observed_sweep_skipped_budget",
			"settled-sweep",
			{ durationMs: Date.now() - started, result: captured.failed },
			{
				ledgerKind: "observed-mutation-budget",
				reason: `settled sweep ${captured.failed}`,
				capPerTurn: { limit: 2, turnIndex: args.turnIndex },
			},
		);
		return { scanned: 0, drifted: [], replayed: 0, reason: captured.failed };
	}

	const current = state();
	const drifted: string[] = [];
	for (const [key, entry] of captured) {
		const next: LedgerEntry = {
			hash: entry.hash,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
		const previous = current.ledger.get(key);
		putLedger(key, next);
		if (current.handled.has(key)) continue;
		if (previous === undefined) continue; // first sighting: seed only
		if (!isDrift(previous, next)) continue;
		if (args.isRecordable?.(key) === false) continue;
		drifted.push(key);
	}

	let replayed = 0;
	for (const filePath of drifted) {
		const editRanges = deriveObservedEditRanges(
			filePath,
			args.getStoredLineHashes?.(filePath),
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
	current.handled.clear();
	if (drifted.length > 0) {
		logLatency({
			type: "phase",
			phase: "observed_settled_sweep_drift",
			filePath: drifted.slice(0, 5).join(","),
			durationMs: Date.now() - started,
			result: `drifted:${drifted.length} replayed:${replayed}`,
		});
	}
	return { scanned: captured.size, drifted, replayed };
}

/**
 * Re-baseline the tracked set AFTER the deferred drain.
 *
 * The drain is pi-lens formatting and autofixing files it already knows about,
 * so those bytes are ours. Without this the next settle would read them as
 * third-party drift and requeue the same files forever.
 */
export async function refreshObservedMutationLedger(
	args: Pick<SettledSweepArgs, "getTrackedPaths" | "signal">,
): Promise<number> {
	const captured = await sweepCapture({
		turnIndex: 0,
		record: () => false,
		...args,
	});
	if ("failed" in captured) return 0;
	seedLedger(captured);
	return captured.size;
}
