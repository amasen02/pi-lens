/**
 * NDJSON telemetry log for diagnostic disposition marks (#690). Same shape as
 * clients/actionable-warnings-logger.ts: machine-global (getGlobalPiLensDir),
 * size-capped with a single `.log.1` backup, isTestMode no-op.
 *
 * Why a log at all: #181 identified false-positive marks flowing to telemetry
 * as THE highest-value rule-tuning signal — which shipped rules misfire, on
 * what tools, how often — and this is that hookup. The disposition store
 * itself is not enough: it keeps only the LATEST entry per anchor (a re-mark
 * overwrites), and `defer` marks never touch the store at all (in-memory by
 * design), so this log is the only durable trace of both re-mark history and
 * defer activity.
 */
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createLazyNdjsonLogger } from "./ndjson-logger.js";

// #2506: resolved lazily (first real write), not at module-import time — see
// `createLazyNdjsonLogger`'s doc comment for why a top-level `getGlobalPiLensDir()`
// call here froze every write to whichever `PI_LENS_HOME` was live at the
// FIRST process that imported this module — confirmed for `latency-logger.ts`/
// `extension-log.ts` via vitest's `globalSetup`, which imports them
// transitively (`grammar-source.ts` -> `degradation-ledger.ts`) before
// `vitest-setup.ts`'s per-worker `PI_LENS_HOME` pin is ever set; the same
// import-order hazard applies to any other process that reaches this module
// first, test or otherwise.
const writer = createLazyNdjsonLogger(() => {
	const dir = getGlobalPiLensDir();
	return {
		filePath: path.join(dir, "dispositions.log"),
		maxBytes: Math.max(
			128 * 1024,
			Number.parseInt(
				process.env.PI_LENS_DISPOSITION_LOG_MAX_BYTES ?? "1048576",
				10,
			) || 1048576,
		),
		backupPath: path.join(dir, "dispositions.log.1"),
	};
});

export interface DispositionLogEntry {
	event: "mark";
	disposition: string;
	tool?: string;
	rule?: string;
	/** Project-relative, forward slashes — file identity without leaking the
	 * machine's absolute layout into a log that may be shared for rule tuning. */
	filePath: string;
	line?: number;
	reason?: string;
	anchor: string;
	/** The store entry's disposition this mark overwrote, when it did — the
	 * re-mark history the latest-wins store loses. */
	previousDisposition?: string;
	/** Model/provider active when the mark was made, when known (#1448 class
	 * sweep — same optional-attribution pattern as WorklogEntry). Blank when
	 * the runtime doesn't know its identity. */
	model?: string;
	provider?: string;
}

export function logDispositionEvent(entry: DispositionLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getDispositionLogPath(): string {
	return writer.getFilePath();
}

/** Resolve once all enqueued disposition writes are on disk. */
export function flushDispositionLog(): Promise<void> {
	return writer.flush();
}

/**
 * Test-only: drop the memoized writer so the next call re-resolves
 * `getGlobalPiLensDir()` against the CURRENT env (#2506).
 */
export function _resetDispositionLoggerForTests(): void {
	writer._resetForTests();
}
