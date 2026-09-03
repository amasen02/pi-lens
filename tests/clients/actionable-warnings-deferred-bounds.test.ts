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
import type { LSPCodeAction, LSPDiagnostic } from "../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

/** Basenames whose `getDiagnostics` never settles — a wedged server. */
let wedgedFiles = new Set<string>();
/**
 * Basenames whose `openFile` never settles (#2504 review round 3, F-B). A
 * server that never acknowledges `didOpen` is the #240 shape: the document
 * the next pull asks about was never received, so an empty pull answers
 * "unknown", not "clean".
 */
let wedgedOpens = new Set<string>();
/** What a FRESH pull returns, by basename. Default: nothing. */
let diagnosticsByFile = new Map<string, LSPDiagnostic[]>();
/** What `codeAction` returns. A record only survives if it has one. */
let codeActions: LSPCodeAction[] = [];

const openFile = vi.fn(async (filePath: string, _content?: string) => {
	if (wedgedOpens.has(path.basename(filePath))) {
		// Never settles: the server never acknowledges the document.
		await new Promise(() => {});
	}
	return undefined;
});
const getDiagnostics = vi.fn(async (filePath: string) => {
	if (wedgedFiles.has(path.basename(filePath))) {
		// Never settles. Only a per-round-trip bound can get past this.
		await new Promise(() => {});
	}
	return diagnosticsByFile.get(path.basename(filePath)) ?? [];
});
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => codeActions);
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
	wedgedOpens = new Set();
	diagnosticsByFile = new Map();
	codeActions = [];
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

describe("#2504 r3 F-A(d) — a second cold-cache turn lets the first finish", () => {
	it("declines the second arm instead of cancelling the in-flight loop", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(2);
		// Keeps loop 1 in flight while turn 2 arrives; it clears on the
		// per-round-trip bound, so the loop still finishes and publishes.
		wedgedFiles.add(path.basename(files[0]));
		const delivered: ActionableWarningsReport[] = [];

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 400,
			onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
		});
		// The handle for the FIRST loop, captured before anything else arms.
		const first = _awaitDeferredLspPullForTest();
		await delay(50);

		// Turn 2 is ALSO cold-cache — in a real editing session every turn is,
		// which is why round 2's abort-on-arm meant back-to-back editing turns
		// delivered NOTHING: each arm cancelled its predecessor, and an aborted
		// loop publishes nothing by design. One slot, but the incumbent keeps
		// it; the newcomer is declined and says so.
		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 2,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 60_000,
			onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
		});

		expect(await settlesWithin(first, 6_000)).toBe("settled");
		expect(delivered.map((r) => r.turnIndex)).toEqual([1]);
	});

	it("arms again once the previous deferral has finished", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);
		const delivered: ActionableWarningsReport[] = [];

		for (const turnIndex of [1, 2]) {
			await buildActionableWarningsReport({
				cwd: env.tmpDir,
				sessionId: "lens-test",
				turnIndex,
				files,
				modifiedRangesByFile: new Map(),
				dispatchWarnings: [],
				includeLspCodeActions: true,
				lspPullTimeoutMs: 400,
				onDeferredReport: (r: ActionableWarningsReport) => delivered.push(r),
			});
			expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
				"settled",
			);
		}

		// Declining is not a latch: the slot is released the moment the work
		// settles, so the very next cold-cache turn defers normally.
		expect(delivered.map((r) => r.turnIndex)).toEqual([1, 2]);
	});

	it("still lets resetLSPService retire the incumbent", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const { resetLSPService } = await import("../../clients/lsp/index.js");
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
		const first = _awaitDeferredLspPullForTest();
		await delay(50);

		// Holding the slot against a NEWER TURN must not also hold it against
		// TEARDOWN: the service lifecycle seam still wins, unconditionally.
		resetLSPService({ fast: true, reason: "session_start" });
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

/**
 * #2504 review round 3 — the deferral's DELIVERY half.
 *
 * Round 2 bounded the loop and guarded its write. Neither half had a positive
 * test: neutering `writeDeferredActionableWarningsReport` to never write left
 * all eight suites green (98/98), because every deferral assertion was about a
 * loop STOPPING. AC3 is not "the sweep stops holding the terminal", it is "the
 * findings still reach the agent, by the cached channel, one turn later at
 * worst". These tests pin that second clause.
 */

/** One unused-variable warning on the modified line, plus its quickfix. */
function armOneActionableWarning(basename: string): void {
	diagnosticsByFile.set(basename, [
		{
			severity: 2,
			message: "v0 is declared but its value is never read.",
			range: {
				start: { line: 0, character: 13 },
				end: { line: 0, character: 15 },
			},
			source: "ts",
			code: 6133,
		},
	]);
	codeActions = [
		{
			title: "Remove unused declaration for v0",
			kind: "quickfix",
			edit: { changes: {} },
		},
	];
}

/** The minimal `turn_end` deps the actionable-warnings path needs. */
function turnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): unknown {
	return {
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
	};
}

describe("#2504 r3 F-A — the deferred report is actually DELIVERED", () => {
	it("lands the off-hook findings in the cache when nothing newer is persisted", async () => {
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
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// The AWAITED report carries nothing: the turn primed no LSP cache, so
		// every pull was deferred. That is the whole point of #2504 — turn_end
		// returns without the 187 s sweep.
		const inBand = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(inBand?.summary.files).toBe(0);

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);
		// The pull genuinely happened, off the hook, exactly once.
		expect(getDiagnostics.mock.calls.length).toBe(1);

		// …and the finding it produced REPLACED the empty in-band report, which
		// is the only way the agent ever sees it.
		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(1);
		expect(persisted?.files[0]?.warnings[0]?.actions.length).toBeGreaterThan(0);
	});

	it("publishes even though the NEXT turn edited a DIFFERENT file", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		const [source, other] = makeSources(2);
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// The next turn edits a file before the deferral finishes. That is the
		// ordinary case, not an edge: the deferral exists precisely because the
		// session is editing. The file under the deferred pull has NOT moved, so
		// its entry still describes current content and must be published.
		runtime.recordProjectMutation({ filePath: other, source: "agent-edit" });
		expect(runtime.projectSeq).toBeGreaterThan(0);

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(1);
	});

	it("drops the entry for the file the NEXT turn edited, and says so", async () => {
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
		armOneActionableWarning(path.basename(source));

		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		// THIS file moves while the deferred pull is reading it. Its findings
		// cite lines in content that no longer exists, and publishing them would
		// also poison checkActionableWarningsReportFresh for the whole report.
		runtime.recordProjectMutation({ filePath: source, source: "agent-edit" });

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.summary.files).toBe(0);
		const superseded = getDegradationSummary().filter(
			(group) => group.kind === "actionable-warnings-deferred-superseded",
		);
		expect(superseded.length).toBe(1);
		expect(superseded[0].latestReasons[0].reason).toContain("LOST");
	});
});

/**
 * #2504 review round 4 (F1) — the deferred report MERGES, per file.
 *
 * Rounds 2 and 3 ordered whole reports: publish, or discard on a newer
 * persisted turnIndex/projectSeqEnd. Composed with incumbent-wins that could
 * only ever discard. Every turn_end with modified files persists an in-band
 * report whose turnIndex strictly increases, and the decline fires exactly
 * when such a turn runs while a loop is in flight — so a decline implied a
 * supersede, always, and the declining turn's EMPTY placeholder out-ranked the
 * incumbent's real findings on ordering alone.
 */
describe("#2504 r4 F1 — the deferred report merges into the persisted one", () => {
	function warning(
		filePath: string,
		id: string,
	): ActionableWarningsReport["files"][number]["warnings"][number] {
		return {
			id,
			filePath,
			displayPath: path.basename(filePath),
			line: 1,
			severity: "warning",
			tool: "typescript",
			message: `finding ${id}`,
			actions: [
				{
					title: "Fix it",
					kind: "quickfix",
					hasEdit: true,
					hasCommand: false,
					autoFixEligible: true,
				},
			],
			suppressed: false,
			origin: "lsp",
		};
	}

	function baseReport(
		over: Partial<ActionableWarningsReport>,
	): ActionableWarningsReport {
		return {
			generatedAt: new Date(2_000_000).toISOString(),
			scope: "turn_delta",
			sessionId: "lens-test",
			turnIndex: 7,
			projectSeqStart: 39,
			projectSeqEnd: 40,
			deltaOnly: true,
			includeLspCodeActions: true,
			files: [],
			summary: {
				warnings: 0,
				unsuppressed: 0,
				byTier: { warning: 0, info: 0, hint: 0 },
				suppressed: 0,
				files: 0,
				actions: 0,
				autoFixEligible: 0,
			},
			...over,
		} as ActionableWarningsReport;
	}

	function fileEntry(
		filePath: string,
		id: string,
		fileSeq: number,
		generatedAt: string,
	): ActionableWarningsReport["files"][number] {
		return {
			filePath,
			displayPath: path.basename(filePath),
			fileSeq,
			generatedAt,
			warnings: [warning(filePath, id)],
		};
	}

	it("upserts its entries into a NEWER persisted report instead of being discarded", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a, b] = makeSources(2);

		// The NEXT turn's in-band report: newer on BOTH whole-report orderings
		// that round 3 refused on.
		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				turnIndex: 8,
				projectSeqEnd: 41,
				generatedAt: new Date(3_000_000).toISOString(),
				files: [fileEntry(b, "b1", 2, new Date(3_000_000).toISOString())],
			}),
			env.tmpDir,
		);

		const result = writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [fileEntry(a, "a1", 5, new Date(2_000_000).toISOString())],
			}),
			// Neither file has moved since its entry was built.
			getFileSeq: (filePath) => (filePath === a ? 5 : 2),
		});

		expect(result.written).toBe(true);
		expect(result.mergedFiles).toBe(1);
		expect(result.droppedFiles).toBe(0);

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		const ids = (persisted?.files ?? []).flatMap((f) =>
			f.warnings.map((w) => w.id),
		);
		expect(ids.sort()).toEqual(["a1", "b1"]);
		// The merged report never claims to be older than its newest part.
		expect(persisted?.turnIndex).toBe(8);
		expect(persisted?.projectSeqEnd).toBe(41);
	});

	it("drops only the file whose fileSeq advanced, and records that loss", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a, b] = makeSources(2);

		const result = writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [
					fileEntry(a, "a1", 5, new Date(2_000_000).toISOString()),
					fileEntry(b, "b1", 2, new Date(2_000_000).toISOString()),
				],
			}),
			// `a` was edited while the deferred pull was reading it; `b` was not.
			getFileSeq: (filePath) => (filePath === a ? 6 : 2),
		});

		// Behaviour first, counters second: the red on pre-fix code has to be
		// "it published the stale entry", not "the result object grew a field".
		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(
			(persisted?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toEqual(["b1"]);
		expect(result.written).toBe(true);
		expect(result.mergedFiles).toBe(1);
		expect(result.droppedFiles).toBe(1);

		// Never silent: the per-file loss is on the ledger, bounded and named.
		const superseded = getDegradationSummary().filter(
			(group) => group.kind === "actionable-warnings-deferred-superseded",
		);
		expect(superseded.length).toBe(1);
		expect(superseded[0].latestReasons[0].reason).toContain(path.basename(a));
	});

	it("unions the warnings when both halves hold the same file", async () => {
		const { writeDeferredActionableWarningsReport } = await loadWarnings();
		const cacheManager = new CacheManager(false);
		const [a] = makeSources(1);

		cacheManager.writeCache(
			"actionable-warnings",
			baseReport({
				turnIndex: 8,
				files: [fileEntry(a, "fresh", 5, new Date(3_000_000).toISOString())],
			}),
			env.tmpDir,
		);
		writeDeferredActionableWarningsReport({
			cacheManager,
			cwd: env.tmpDir,
			report: baseReport({
				files: [fileEntry(a, "deferred", 5, new Date(2_000_000).toISOString())],
			}),
			getFileSeq: () => 5,
		});

		const persisted = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(persisted?.files.length).toBe(1);
		expect(persisted?.files[0].warnings.map((w) => w.id).sort()).toEqual([
			"deferred",
			"fresh",
		]);
		// The entry now carries both observations, so it must be aged by the
		// EARLIER of them — an out-of-band edit after that moment makes every
		// line in it suspect, not only the older half's.
		expect(persisted?.files[0].generatedAt).toBe(
			new Date(2_000_000).toISOString(),
		);
		expect(persisted?.summary.warnings).toBe(2);
	});
});
describe("#2504 r3 F-B — an unacknowledged open is never read as clean", () => {
	it("skips the file rather than pulling for a document the server never received", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);
		wedgedOpens.add(path.basename(files[0]));

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 200,
			onDeferredReport: () => {},
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
			"settled",
		);
		// #240. The bounded `openFile` lost to its timeout, so the server never
		// received the document. Pulling anyway asks it about a file it has
		// never seen; the empty answer means UNKNOWN, and the pre-fix code
		// logged the file `lsp_file_checked lspSource:"fresh"` — a failed pull
		// read as clean, which is exactly what the comment beside the pull
		// promises never happens.
		expect(getDiagnostics.mock.calls.length).toBe(0);
	});

	it("still pulls when the open was acknowledged", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await loadWarnings();
		const files = makeSources(1);

		await buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspPullTimeoutMs: 200,
			onDeferredReport: () => {},
		});

		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 4_000)).toBe(
			"settled",
		);
		expect(getDiagnostics.mock.calls.length).toBe(1);
	});
});

/**
 * #2504 review round 4 (F1) — the reviewer's P1 choreography, end to end.
 *
 * Two back-to-back cold turns through the REAL handleTurnEnd. Turn 0 arms a
 * deferral; turn 1 runs while that loop is still in flight, so its own cold
 * files are declined, and it persists its in-band report with a strictly
 * higher turnIndex. Then turn 0's loop lands.
 *
 * Pre-fix that composition published NOTHING: the incumbent's real findings
 * lost to the declining turn's report on whole-report ordering alone, and the
 * declining turn had nothing of its own to contribute for the files it
 * skipped. Both turns' warnings were gone.
 */
describe("#2504 r4 F1 — two back-to-back cold turns both deliver", () => {
	it("keeps turn 1's in-band entries AND turn 0's deferred finding", async () => {
		const { _awaitDeferredLspPullForTest } = await loadWarnings();
		const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const [deferredFile, dispatchFile] = makeSources(2);

		// ── turn 0: one modified file, nothing primed, so the loop defers.
		runtime.beginTurn();
		cacheManager.addModifiedRange(
			deferredFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		armOneActionableWarning(path.basename(deferredFile));
		// Wedged, so turn 0's loop is still in flight when turn 1 runs.
		wedgedFiles.add(path.basename(deferredFile));
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);
		const turnZeroIndex = runtime.turnIndex;

		// ── turn 1: a dispatch warning of its own, plus a cold file whose
		// deferral is DECLINED because turn 0 still holds the slot.
		runtime.beginTurn();
		expect(runtime.turnIndex).toBeGreaterThan(turnZeroIndex);
		cacheManager.addModifiedRange(
			dispatchFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);
		runtime.recordActionableWarnings([
			{
				id: "turn1-dispatch",
				filePath: dispatchFile,
				displayPath: path.basename(dispatchFile),
				line: 1,
				severity: "warning",
				tool: "ast-grep",
				message: "turn 1 found this itself",
				actions: [],
				suppressed: false,
				origin: "dispatch",
			},
		]);
		// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		await handleTurnEnd(turnEndDeps(runtime, cacheManager) as any);

		const afterTurnOne = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		expect(
			(afterTurnOne?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toEqual(["turn1-dispatch"]);

		// ── turn 0's incumbent loop finally lands.
		wedgedFiles.clear();
		expect(await settlesWithin(_awaitDeferredLspPullForTest(), 8_000)).toBe(
			"settled",
		);

		const finalReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			env.tmpDir,
		)?.data;
		const paths = (finalReport?.files ?? []).map((f) => f.filePath).sort();
		expect(paths).toEqual([deferredFile, dispatchFile].sort());
		// Turn 1 kept what it found in band...
		expect(
			(finalReport?.files ?? []).flatMap((f) => f.warnings.map((w) => w.id)),
		).toContain("turn1-dispatch");
		// ...and turn 0's deferred LSP finding arrived beside it, with its fix
		// action, which is the only way the agent ever sees it.
		const deferredEntry = (finalReport?.files ?? []).find(
			(f) => f.filePath === deferredFile,
		);
		expect(deferredEntry?.warnings.length).toBe(1);
		expect(deferredEntry?.warnings[0].actions.length).toBeGreaterThan(0);
		expect(finalReport?.summary.files).toBe(2);
	});
});
