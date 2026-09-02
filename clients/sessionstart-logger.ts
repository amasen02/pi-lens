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
const writer = createLazyNdjsonLogger(() => ({
	filePath: path.join(getGlobalPiLensDir(), "sessionstart.log"),
}));

export function logSessionStart(message: string): void {
	if (isTestMode()) return;
	writer.append(`[${new Date().toISOString()}] ${message}`);
}

export function getSessionStartLogPath(): string {
	return writer.getFilePath();
}

export function flushSessionStartLog(): Promise<void> {
	return writer.flush();
}

export function flushSessionStartLogSync(): void {
	writer.flushSync();
}

/**
 * Test-only: drop the memoized writer so the next call re-resolves
 * `getGlobalPiLensDir()` against the CURRENT env (#2506).
 */
export function _resetSessionStartLogForTests(): void {
	writer._resetForTests();
}
