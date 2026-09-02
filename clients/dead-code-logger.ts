/**
 * NDJSON telemetry for cross-file dead-code scans (#127). One event per
 * session_start scan per language, so we can answer: which languages get
 * scanned, how many findings, and how long the whole-project scan takes (the
 * input to phasing decisions in the issue). Mirrors `ast-grep-tool-logger.ts`
 * for shape + size-based rotation.
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
		filePath: path.join(dir, "dead-code.log"),
		maxBytes: Math.max(
			128 * 1024,
			Number.parseInt(
				process.env.PI_LENS_DEAD_CODE_LOG_MAX_BYTES ?? "1048576",
				10,
			) || 1048576,
		),
		backupPath: path.join(dir, "dead-code.log.1"),
	};
});

export interface DeadCodeScanEvent {
	language: string;
	sessionId?: string;
	success: boolean;
	cached: boolean;
	unusedExports: number;
	unusedFiles: number;
	unusedDeps: number;
	unlistedDeps: number;
	durationMs?: number;
	reason?: string;
}

/**
 * Append one scan event. Fire-and-forget: telemetry must never break a scan, so
 * every fs error is swallowed. Skipped under test mode to keep the suite from
 * writing to the user's real ~/.pi-lens.
 */
export function logDeadCodeScan(event: DeadCodeScanEvent): void {
	if (isTestMode()) return;
	writer.log({ ts: new Date().toISOString(), ...event });
}

/** Resolve once all enqueued dead-code writes are on disk (tests/shutdown). */
export function flushDeadCodeLog(): Promise<void> {
	return writer.flush();
}

export function getDeadCodeLogPath(): string {
	return writer.getFilePath();
}

/**
 * Test-only: drop the memoized writer so the next call re-resolves
 * `getGlobalPiLensDir()` against the CURRENT env (#2506).
 */
export function _resetDeadCodeLoggerForTests(): void {
	writer._resetForTests();
}
