/**
 * #2504 review round 2 — the DEFERRED off-hook actionable-warnings loop.
 *
 * #2504 moved the cold-cache LSP fresh-pull loop off the awaited `turn_end`
 * hook. Two defects came with it:
 *
 *  - F2. The deferred report is stamped with the ORIGINATING turn's
 *    `turnIndex`/`projectSeq` and may land up to 60 s (many turns) later,
 *    where it overwrote a NEWER report. `agent_end` then read that cache
 *    back, saw `project_seq_mismatch`, and silently skipped the autofix pass;
 *    `lens_diagnostics` re-served the same stale delta.
 *  - F3. The loop had effectively ONE bound. Its `signal` was the COMPLETED
 *    turn's `ctx.signal`, which `index.ts` clears from the ambient slot in its
 *    `finally` and which therefore never fires; the only live bound was a 60 s
 *    wall deadline checked BETWEEN files. A wedged `getDiagnostics` was
 *    unbounded, the loop kept opening files after `turn_end` returned and
 *    after the LSP idle reset, a `session_shutdown` mid-loop hit the #234
 *    spawn-at-teardown shape, and a second deferral simply overwrote the
 *    module-level handle, leaving the first loop running and unstoppable.
 *
 * The LSP SERVICE is faked here, but `resetLSPService` is the real one
 * (`importOriginal` below): the session_shutdown tests drive production's own
 * teardown entry point, not a stand-in for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { ActionableWarningsReport } from "../../clients/actionable-warnings.js";
import type { LSPCodeAction } from "../../clients/lsp/client.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Basenames whose `getDiagnostics` never settles — a wedged server. */
let wedgedFiles = new Set<string>();

const openFile = vi.fn(
	async (_filePath: string, _content?: string) => undefined,
);
const getDiagnostics = vi.fn(async (filePath: string) => {
	if (wedgedFiles.has(path.basename(filePath))) {
		// Never settles. Only a per-round-trip bound can get past this.
		await new Promise(() => {});
	}
	return [];
});
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => []);
/** Nothing is ever primed: every file is a cold fresh pull, so it defers. */
const getLastKnownDiagnostics = vi.fn(() => undefined);

const fakeService = {
	supportsLSP: (filePath: string) => filePath.endsWith(".ts"),
	openFile,
	getDiagnostics,
	codeAction,
	getLastKnownDiagnostics,
};

vi.mock("../../clients/lsp/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/index.js")>();
	return { ...actual, getLSPService: () => fakeService };
});

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2504-deferred-");
	wedgedFiles = new Set();
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	resetDegradationLedger();
});

afterEach(() => {
	env.cleanup();
	resetDegradationLedger();
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve to `"settled"` when `work` finishes first, `"pending"` when it is
 * still running after `ms`. Written as a race rather than an `await` so an
 * UNBOUNDED loop reports a failed assertion instead of hanging the suite until
 * vitest's own timeout — the pre-fix red has to be readable.
 */
async function settlesWithin(
	work: Promise<unknown>,
	ms: number,
): Promise<"settled" | "pending"> {
	return await Promise.race([
		work.then(() => "settled" as const),
		delay(ms).then(() => "pending" as const),
	]);
}

function makeSources(count: number): string[] {
	const dir = path.join(env.tmpDir, "src");
	fs.mkdirSync(dir, { recursive: true });
	const made: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = path.join(dir, `f${i}.ts`);
		fs.writeFileSync(p, `export const v${i} = ${i};\n`);
		made.push(p);
	}
	return made;
}

async function loadWarnings() {
	return await import("../../clients/actionable-warnings.js");
}

describe("#2504 r2 F3 — per-round-trip bound on the deferred loop", () => {
	it("does not let a wedged getDiagnostics hold the deferred loop open", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(3);
		wedgedFiles.add("f0.ts");

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 150,
			onDeferredReport: () => {},
		});

		// Pre-fix the ONLY bound is a 60 s deadline checked BETWEEN files, so a
		// pull that never answers pins the loop forever.
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		// And it moved PAST the wedged file rather than abandoning the batch.
		expect(getDiagnostics.mock.calls.length).toBe(3);
	});
});

describe("#2504 r2 F3 — session_shutdown aborts the deferred loop", () => {
	it("stops within the per-pull bound and opens no further file", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		// The REAL teardown entry point — every lifecycle path (session_shutdown,
		// session_start, the idle reset) retires the service through it.
		const { resetLSPService } = await import("../../clients/lsp/index.js");
		const files = makeSources(6);
		for (const f of files) wedgedFiles.add(path.basename(f));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: () => {},
		});

		// Let the loop get into its first (wedged) pull.
		await delay(50);
		const openedBeforeShutdown = openFile.mock.calls.length;
		expect(openedBeforeShutdown).toBeGreaterThan(0);

		resetLSPService({
			fast: true,
			processExiting: true,
			reason: "session_shutdown",
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		// No further document was handed to a service being torn down.
		expect(openFile.mock.calls.length).toBe(openedBeforeShutdown);
	});

	it("delivers no report from an aborted loop", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const { resetLSPService } = await import("../../clients/lsp/index.js");
		const files = makeSources(4);
		for (const f of files) wedgedFiles.add(path.basename(f));
		const delivered: unknown[] = [];

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: (r: unknown) => delivered.push(r),
		});

		await delay(50);
		resetLSPService({ fast: true, reason: "session_start" });

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 2_500)).toBe(
			"settled",
		);
		expect(delivered).toEqual([]);
	});
});

describe("#2504 r2 F3 — a second deferral retires the first", () => {
	it("aborts the loop that already held the slot", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(5);
		for (const f of files) wedgedFiles.add(path.basename(f));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: () => {},
		});
		// The handle for the FIRST loop, captured before anything re-arms.
		const first = _awaitDeferredLspPullForTest();
		await delay(50);

		// A second turn defers too. Pre-fix this only overwrote a module-level
		// `let`: the first loop kept running, untracked and unstoppable.
		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 2,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: () => {},
		});

		expect(await settlesWithin(first, 2_500)).toBe("settled");
	});
});

describe("#2504 r2 F2 — a deferred report never clobbers a newer one", () => {
	it("keeps turn N+1's report when turn N's deferred loop lands after it", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const source = makeSources(1)[0];
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		// One wedged file is enough to keep the deferred loop running while
		// "turn N+1" writes underneath it.
		wedgedFiles.add(path.basename(source));

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
			getFlag: (name: string) =>
				name === "lens-actionable-warnings" ||
				name === "lens-actionable-warning-actions",
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: { getTestRunTarget: () => null },
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		const turnNReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(turnNReport).toBeDefined();

		// Turn N+1 completes and writes its own, NEWER report while turn N's
		// deferred loop is still pulling.
		const newer: ActionableWarningsReport = {
			...(turnNReport as ActionableWarningsReport),
			generatedAt: new Date().toISOString(),
			turnIndex: (turnNReport as ActionableWarningsReport).turnIndex + 1,
			projectSeqStart: 40,
			projectSeqEnd: 41,
			files: [],
		};
		cacheManager.writeCache("actionable-warnings", newer, env.tmpDir);

		// Unwedge, so the deferred loop finishes and tries to publish.
		wedgedFiles.clear();
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.turnIndex).toBe(newer.turnIndex);
		expect(persisted?.projectSeqEnd).toBe(41);
	});
});
