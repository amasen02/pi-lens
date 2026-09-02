import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createLazyNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { normalizeLoggedPath } from "./path-utils.js";

// #2506: resolved lazily (first real write), not at module-import time — see
// `createLazyNdjsonLogger`'s doc comment for why a top-level `getGlobalPiLensDir()`
// call here froze every write to whichever `PI_LENS_HOME` was live at the
// FIRST process that imported this module — confirmed for `latency-logger.ts`/
// `extension-log.ts` via vitest's `globalSetup`, which imports them
// transitively (`grammar-source.ts` -> `degradation-ledger.ts`) before
// `vitest-setup.ts`'s per-worker `PI_LENS_HOME` pin is ever set; the same
// import-order hazard applies to any other process that reaches this module
// first, test or otherwise.
const writer = createLazyNdjsonLogger(() => ({
	filePath: path.join(getGlobalPiLensDir(), "cascade.log"),
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
}));

export interface CascadeLogEntry {
	ts?: string;
	phase:
		| "cascade_skip" // primary has blockers, non-code file, or unsupported graph kind
		| "graph_build" // graph built or reused
		| "reverse_deps_cache" // reverse dependency cache refresh/load/merge
		| "neighbors_computed" // impact cascade result ready
		| "neighbor_touch" // single neighbor LSP active touch result
		| "neighbor_snapshot" // neighbor read from passive snapshot (autoPropagate jsts)
		| "neighbor_fallback" // neighbor fell back to getAllDiagnostics (error or degraded)
		| "cascade_result" // final per-file cascade result
		| "cascade_turn_end" // merged result emitted at turn_end
		| "cascade_indeterminate" // #1023: impact could not be computed — honest advisory surfaced
		| "cascade_tier3_skip" // #458: in-lane wait skipped for a tier-3 neighbor touch
		| "cascade_tier3_reconcile" // #458: quiet-window reconcile of outstanding tier-3 touches
		| "cascade_carry_over_drop" // #1443: late/carried run dropped — superseded by a later write, or the one-turn carry bound lapsed
		| "cascade_injected" // #1446 item 1: what cascade text actually reached blockerParts this turn
		| "cascade_test_targets"; // #1446 item 2: which tests were suggested for cascade neighbors, including the zero-suggestion case
	filePath: string;
	neighborFile?: string;
	reason?: string;

	// graph_build
	graphBuiltMs?: number;
	graphReused?: boolean; // true when FactStore cache was valid (future: incremental rebuild)
	graphNodeCount?: number;
	graphFileCount?: number;
	graphChangedSymbolCount?: number;

	// neighbors_computed
	neighborCount?: number;
	totalNeighborCount?: number; // before cap
	importerCount?: number;
	callerCount?: number;
	referenceCount?: number;
	riskFlags?: string[];

	// neighbor_snapshot
	snapshotMissing?: boolean; // true when file not found in allDiags
	snapshotAgeSec?: number; // age of snapshot entry in seconds

	// neighbor_touch
	lspServerCount?: number; // number of LSP servers configured for this file type
	touchedCount?: number;
	snapshotCount?: number;
	coldSnapshot?: boolean; // true when touch was triggered because autoPropagate snapshot was missing

	// shared
	fallbackUsed?: boolean;
	diagnosticCount?: number;
	durationMs?: number;
	autoPropagate?: boolean;
	lspTouched?: boolean;
	error?: string;
	metadata?: Record<string, unknown>;
}

/**
 * #2219 (the #2141 class): call sites across `dispatch/integration.ts`,
 * `runtime-turn.ts`, and `runtime-coordinator.ts` feed a mix of raw
 * `filePath`/`cwd` params and (for `lsp/cascade-tier.ts`) the
 * `"<quiet-window>"` sentinel. Normalize once here, the single emit seam —
 * same pattern as `review-graph-logger.ts`'s `logReviewGraph`, guarded via
 * `normalizeLoggedPath` so the non-path sentinel passes through unchanged
 * instead of being resolved against the process cwd.
 */
export function logCascade(entry: CascadeLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		filePath: normalizeLoggedPath(entry.filePath),
	});
}

export function getCascadeLogPath(): string {
	return writer.getFilePath();
}

/** Resolve once all enqueued cascade writes are on disk (tests/shutdown). */
export function flushCascadeLog(): Promise<void> {
	return writer.flush();
}

/**
 * Test-only: drop the memoized writer so the next call re-resolves
 * `getGlobalPiLensDir()` against the CURRENT env (#2506).
 */
export function _resetCascadeLoggerForTests(): void {
	writer._resetForTests();
}
