import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createLazyNdjsonLogger } from "./ndjson-logger.js";
import { normalizeFilePath } from "./path-utils.js";

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
		filePath: path.join(dir, "actionable-warnings.log"),
		maxBytes: Math.max(
			128 * 1024,
			Number.parseInt(process.env.PI_LENS_AW_LOG_MAX_BYTES ?? "1048576", 10) ||
				1048576,
		),
		backupPath: path.join(dir, "actionable-warnings.log.1"),
	};
});

export interface ActionableWarningsLogEntry {
	event: string;
	sessionId?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}

/**
 * #2219 (the #2141 class): `filePath` reaches here from
 * `actionable-warnings.ts`'s raw `path.resolve(cwd, file)` — the file
 * imports `normalizeMapKey` and uses it for map lookups on this same value,
 * but never normalizes what gets logged. `filePath` is optional (several
 * events, e.g. `report_started`/`report_complete`, carry none), so only
 * normalize when present.
 */
export function logActionableWarningsEvent(
	entry: ActionableWarningsLogEntry,
): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		...(entry.filePath !== undefined
			? { filePath: normalizeFilePath(entry.filePath) }
			: {}),
	});
}

export function getActionableWarningsLogPath(): string {
	return writer.getFilePath();
}

/** Resolve once all enqueued actionable-warnings writes are on disk. */
export function flushActionableWarningsLog(): Promise<void> {
	return writer.flush();
}

/**
 * Test-only: drop the memoized writer so the next call re-resolves
 * `getGlobalPiLensDir()` against the CURRENT env (#2506).
 */
export function _resetActionableWarningsLoggerForTests(): void {
	writer._resetForTests();
}
