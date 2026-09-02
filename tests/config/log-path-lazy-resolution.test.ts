/**
 * #2506 governance: no `*-logger.ts` writer may freeze its log path at
 * MODULE-IMPORT time.
 *
 * Root cause (see `clients/ndjson-logger.ts`'s `createLazyNdjsonLogger` doc
 * comment for the full account): every machine-global `*-logger.ts` module
 * used to resolve `getGlobalPiLensDir()` (which reads `PI_LENS_HOME`) into a
 * top-level `const`, evaluated once at import time. Whichever process
 * imported the module FIRST froze every later write to whatever
 * `PI_LENS_HOME` was live at THAT moment. Confirmed live (2026-09-02): a
 * canary in `tests/support/prewarm-grammars.ts` (a vitest `globalSetup` file,
 * which runs before `tests/support/vitest-setup.ts`'s per-worker
 * `PI_LENS_HOME` pin) printed `PI_LENS_HOME=undefined` — i.e. `os.homedir()`
 * — at the exact moment `grammar-source.ts` -> `degradation-ledger.ts`
 * transitively imported `latency-logger.ts` and `extension-log.ts`. Nothing
 * wrote there THAT run only because `isTestMode()` (a SEPARATE gate) happened
 * to also be true in `globalSetup` — a single point of failure the fix below
 * removes, rather than relying on.
 *
 * Two independent checks:
 *  1. BEHAVIORAL — for every lazy logger, prove the resolved path tracks the
 *     CURRENT `PI_LENS_HOME`, never a value frozen at a prior import/call.
 *     Mutation: revert a logger to a top-level `const X = getGlobalPiLensDir()`
 *     (dropping its `_resetXLoggerForTests` export in the process) and this
 *     goes red — either the import throws (no such export) or the resolved
 *     path stops tracking the env change.
 *  2. STATIC — grep-sweep every `clients/*.ts` file for the exact
 *     `const NAME = getGlobalPiLensDir()` (or `path.join(getGlobalPiLensDir(), ...)`)
 *     shape at column 0 (module scope). Mutation: reintroduce that shape in
 *     any file (this one included, or a brand new sibling) and this goes red.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { repoRoot } from "../support/module-instance-scan.js";
import {
	assertNonEmptyScan,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { removeTempDirSync } from "../clients/test-utils.js";

// --- 1. Behavioral: every lazy logger re-resolves against the CURRENT env ---

interface LazyLoggerCase {
	/** Module specifier, relative to this file. */
	modulePath: string;
	/** Exported `get*LogPath(): string` accessor. */
	getPath: string;
	/** Exported `_reset*ForTests(): void` — drops the memoized writer. */
	reset: string;
}

const LAZY_LOGGER_CASES: LazyLoggerCase[] = [
	{
		modulePath: "../../clients/latency-logger.js",
		getPath: "getLatencyLogPath",
		reset: "_resetLatencyLoggerForTests",
	},
	{
		modulePath: "../../clients/extension-log.js",
		getPath: "getExtensionLogPath",
		reset: "_resetExtensionLogForTests",
	},
	{
		modulePath: "../../clients/sessionstart-logger.js",
		getPath: "getSessionStartLogPath",
		reset: "_resetSessionStartLogForTests",
	},
	{
		modulePath: "../../clients/ast-grep-tool-logger.js",
		getPath: "getAstGrepToolLogPath",
		reset: "_resetAstGrepToolLoggerForTests",
	},
	{
		modulePath: "../../clients/bus-events-logger.js",
		getPath: "getBusEventsLogPath",
		reset: "_resetBusEventsLoggerForTests",
	},
	{
		modulePath: "../../clients/cascade-logger.js",
		getPath: "getCascadeLogPath",
		reset: "_resetCascadeLoggerForTests",
	},
	{
		modulePath: "../../clients/dead-code-logger.js",
		getPath: "getDeadCodeLogPath",
		reset: "_resetDeadCodeLoggerForTests",
	},
	{
		modulePath: "../../clients/disposition-logger.js",
		getPath: "getDispositionLogPath",
		reset: "_resetDispositionLoggerForTests",
	},
	{
		modulePath: "../../clients/read-guard-logger.js",
		getPath: "getReadGuardLogPath",
		reset: "_resetReadGuardLoggerForTests",
	},
	{
		modulePath: "../../clients/review-graph-logger.js",
		getPath: "getReviewGraphLogPath",
		reset: "_resetReviewGraphLoggerForTests",
	},
	{
		modulePath: "../../clients/tree-sitter-logger.js",
		getPath: "getTreeSitterLogPath",
		reset: "_resetTreeSitterLoggerForTests",
	},
	{
		modulePath: "../../clients/word-index-logger.js",
		getPath: "getWordIndexLogPath",
		reset: "_resetWordIndexLoggerForTests",
	},
	{
		modulePath: "../../clients/actionable-warnings-logger.js",
		getPath: "getActionableWarningsLogPath",
		reset: "_resetActionableWarningsLoggerForTests",
	},
];

let previousHome: string | undefined;
const tempRoots: string[] = [];

function tmpHome(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

beforeEach(() => {
	previousHome = process.env.PI_LENS_HOME;
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	for (const dir of tempRoots.splice(0)) removeTempDirSync(dir);
	vi.resetModules();
});

describe("#2506: lazy logger path resolution tracks the CURRENT PI_LENS_HOME", () => {
	for (const { modulePath, getPath, reset } of LAZY_LOGGER_CASES) {
		it(`${modulePath.split("/").pop()} never freezes at import/first-call time`, async () => {
			const homeA = normalizeFilePath(tmpHome("pi-lens-2506-a-"));
			process.env.PI_LENS_HOME = homeA;
			vi.resetModules();

			const mod = (await import(modulePath)) as Record<string, unknown>;
			const getPathFn = mod[getPath];
			const resetFn = mod[reset];
			expect(typeof getPathFn, `${modulePath} must export ${getPath}`).toBe(
				"function",
			);
			expect(typeof resetFn, `${modulePath} must export ${reset}`).toBe(
				"function",
			);

			const pathA = normalizeFilePath((getPathFn as () => string)());
			expect(pathA.startsWith(homeA), `${pathA} should be under ${homeA}`).toBe(
				true,
			);

			// The env changes AFTER the module was already imported/resolved once —
			// exactly the globalSetup-then-per-worker-pin sequence this governance
			// test exists to guard. A top-level frozen `const` would keep returning
			// `pathA` here; the lazy writer must re-resolve.
			const homeB = normalizeFilePath(tmpHome("pi-lens-2506-b-"));
			process.env.PI_LENS_HOME = homeB;
			(resetFn as () => void)();
			const pathB = normalizeFilePath((getPathFn as () => string)());

			expect(pathB.startsWith(homeB), `${pathB} should be under ${homeB}`).toBe(
				true,
			);
			expect(pathB.startsWith(homeA)).toBe(false);
		});
	}
});

// --- 2. Canary: an actual write, forced past the isTestMode() gate, must
// never touch the developer's real ~/.pi-lens (the literal #2506 symptom).

describe("#2506: a forced real write never lands under the real os.homedir()", () => {
	it("logLatency() writes only under the pinned PI_LENS_HOME, not the real home", async () => {
		const realLatencyLog = path.join(os.homedir(), ".pi-lens", "latency.log");
		const beforeMtime = fs.existsSync(realLatencyLog)
			? fs.statSync(realLatencyLog).mtimeMs
			: undefined;

		const home = normalizeFilePath(tmpHome("pi-lens-2506-canary-"));
		process.env.PI_LENS_HOME = home;
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0"; // force past the isTestMode() gate
		vi.resetModules();

		try {
			const { logLatency, getLatencyLogPath, flushLatencyLog } =
				await import("../../clients/latency-logger.js");
			logLatency({
				type: "phase",
				phase: "test_2506_canary",
				filePath: "<test>",
				durationMs: 0,
			});
			await flushLatencyLog();

			const resolvedPath = normalizeFilePath(getLatencyLogPath());
			expect(resolvedPath.startsWith(home)).toBe(true);
			expect(fs.existsSync(resolvedPath)).toBe(true);
			expect(fs.readFileSync(resolvedPath, "utf8")).toContain(
				"test_2506_canary",
			);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
			vi.resetModules();
		}

		// The canary: the REAL ~/.pi-lens/latency.log (if it exists at all) must
		// be byte-for-byte untouched by this test run — no new mtime.
		const afterMtime = fs.existsSync(realLatencyLog)
			? fs.statSync(realLatencyLog).mtimeMs
			: undefined;
		expect(afterMtime).toBe(beforeMtime);
	});
});

// --- 3. Static sweep: the frozen-at-import SHAPE must not exist anywhere
// under `clients/**/*-logger.ts` (plus their two flag-gated cousins and the
// shared rotation helper), present or future.
//
// Scoped to the LOGGER class, not every `getGlobalPiLensDir()` call in
// `clients/`: the same sweep also found `TOOLS_DIR`/`PI_LENS_BIN_DIR`/
// `PROBE_CACHE_PATH`/`GITHUB_BIN_DIR`-shaped top-level consts in
// `clients/installer/index.ts`, `clients/lsp/launch.ts`,
// `clients/lsp/server.ts`, and
// `clients/dispatch/runners/utils/runner-helpers.ts` — the same root defect
// shape, but for tool-install/binary paths rather than NDJSON log writers,
// with a different risk profile (spawns, not appends) and existing
// test-template machinery (`PI_LENS_TEST_TOOLS_TEMPLATE`) this fix did not
// audit. Tracked as a follow-up rather than folded in here blind — see the
// #2506 PR body.
const LOGGER_SWEEP_ROOTS = [
	"latency-logger.ts",
	"extension-log.ts",
	"sessionstart-logger.ts",
	"ast-grep-tool-logger.ts",
	"bus-events-logger.ts",
	"cascade-logger.ts",
	"dead-code-logger.ts",
	"disposition-logger.ts",
	"read-guard-logger.ts",
	"review-graph-logger.ts",
	"tree-sitter-logger.ts",
	"word-index-logger.ts",
	"actionable-warnings-logger.ts",
	"debug-handles.ts",
	"debug-heap.ts",
	"log-cleanup.ts",
];

/**
 * A module-scope (column-0) declaration whose initializer calls
 * `getGlobalPiLensDir()` directly, or wraps it in one `path.join(...)` —
 * every shape this sweep found and fixed across the always-active loggers.
 * `[\s\S]*?` lets the initializer span the multi-line
 * `path.join(\n  getGlobalPiLensDir(),\n  "x.log",\n)` shape several of them
 * used, bounded to a short lookahead so it cannot accidentally span into an
 * unrelated LATER declaration.
 */
const TOP_LEVEL_FROZEN_PATTERN =
	/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]+)?=\s*(?:path\.join\(\s*)?getGlobalPiLensDir\(\)/m;

describe("#2506: no clients/*-logger.ts file re-introduces the frozen-at-import shape", () => {
	it("scans every registered logger source file", () => {
		const clientsDir = path.join(repoRoot, "clients");
		const files = LOGGER_SWEEP_ROOTS.map((name) => path.join(clientsDir, name));
		assertNonEmptyScan("logger file list", files.length);
		for (const file of files) {
			expect(
				fs.existsSync(file),
				`${file} must exist — update this sweep's file list if it moved`,
			).toBe(true);
		}

		const flagged: string[] = [];
		for (const file of files) {
			const source = fs.readFileSync(file, "utf8");
			const stripped = stripSource(source);
			if (TOP_LEVEL_FROZEN_PATTERN.test(stripped)) {
				flagged.push(relativePosix(repoRoot, file));
			}
		}
		expect(flagged).toEqual([]);
	});
});
