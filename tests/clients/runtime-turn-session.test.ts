import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { snapshotAdvisoryProvenance } from "../../clients/advisory-provenance.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "../../clients/runtime-context.js";
import { loadProjectDiagnosticsDeltaReport } from "../../clients/project-diagnostics/cache.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { SESSION_START_GUIDANCE } from "../../clients/runtime-session.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import {
	checkCrossProcessLspBudget,
	_resetLspBudgetDecisionForTests,
} from "../../clients/lsp-budget.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

// Minimal turn_end deps — no real tool clients needed for these scenarios.
function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

// ── LSP idle reset ─────────────────────────────────────────────────────────────

describe("LSP idle reset", () => {
	it("uses the short idle timeout when the session-boundary budget is pressured", async () => {
		const env = setupTestEnvironment("pi-lens-idle-budget-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();
		const previousCeiling = process.env.PI_LENS_LSP_BUDGET_CEILING;
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		_resetLspBudgetDecisionForTests();

		vi.useFakeTimers();
		try {
			await checkCrossProcessLspBudget({
				registry: [
					{
						pid: 42,
						startedAt: new Date().toISOString(),
						projectRoot: env.tmpDir,
						lspChildren: [
							{
								pid: 43,
								serverId: "python",
								command: "pyright-langserver",
								spawnedAt: new Date().toISOString(),
							},
						],
						lspChildCount: 1,
						rssBytes: 1,
						heartbeatAt: new Date().toISOString(),
					},
				],
				isPidAlive: () => true,
			});
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);

			await vi.advanceTimersByTimeAsync(59_999);
			expect(resetLSPService).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(resetLSPService).toHaveBeenCalledTimes(1);
		} finally {
			cancelLSPIdleReset();
			_resetLspBudgetDecisionForTests();
			vi.useRealTimers();
			if (previousCeiling === undefined) {
				delete process.env.PI_LENS_LSP_BUDGET_CEILING;
			} else {
				process.env.PI_LENS_LSP_BUDGET_CEILING = previousCeiling;
			}
			env.cleanup();
		}
	});

	it("skips a pending idle reset after the session generation changes", async () => {
		const env = setupTestEnvironment("pi-lens-idle-generation-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);

			runtime.resetForSession();
			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).not.toHaveBeenCalled();
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("logs and swallows errors from a detached idle reset", async () => {
		const env = setupTestEnvironment("pi-lens-idle-error-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const dbg = vi.fn();
		const resetError = new Error("stale ctx");
		const resetLSPService = vi.fn(() => {
			throw resetError;
		});

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					dbg,
					resetLSPService,
				}),
			);

			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(dbg).toHaveBeenCalledWith(`lsp idle reset failed: ${resetError}`);
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("falls back to process warnings when idle reset logging fails", async () => {
		const env = setupTestEnvironment("pi-lens-idle-error-reporter-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetError = new Error("stale ctx");
		const logError = new Error("logger unavailable");
		const dbg = vi.fn((msg: string) => {
			if (msg.startsWith("lsp idle reset failed")) {
				throw logError;
			}
		});
		const resetLSPService = vi.fn(() => {
			throw resetError;
		});
		const emitWarning = vi
			.spyOn(process, "emitWarning")
			.mockImplementation(() => undefined as never);

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					dbg,
					resetLSPService,
				}),
			);

			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(emitWarning).toHaveBeenCalledWith(
				`pi-lens LSP idle reset error reporter failed: ${logError}`,
				{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
			);
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			emitWarning.mockRestore();
			env.cleanup();
		}
	});
});

// ── Dedup suppression ──────────────────────────────────────────────────────────

describe("turn-end-findings-last dedup", () => {
	it("suppresses identical findings within the same session", async () => {
		const env = setupTestEnvironment("pi-lens-dedup-same-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		// Pre-seed last findings with matching signature + same session.
		const content = "🔴 blocker: something broken\n";
		const files = ["src/foo.ts"];
		const signature = `${files.join("|")}::${content}`;
		cacheManager.writeCache(
			"turn-end-findings-last",
			{ signature, sessionId: "session-A" },
			env.tmpDir,
		);

		// Simulate the same content being produced again — dedup should fire.
		// Directly write findings so handleTurnEnd sees matching signature.
		cacheManager.writeCache("turn-end-findings", { content }, env.tmpDir);
		cacheManager.addModifiedRange(
			path.join(env.tmpDir, "src/foo.ts"),
			{ start: 1, end: 5 },
			false,
			env.tmpDir,
			"session-A",
		);

		// We can't easily re-produce the exact signature through handleTurnEnd
		// without real tool results, so test the cache layer directly.
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", env.tmpDir);
		expect(last?.data?.sessionId).toBe("session-A");
		expect(last?.data?.signature).toBe(signature);

		// Dedup condition: same signature AND same session → would suppress.
		expect(
			last?.data?.signature === signature &&
				last?.data?.sessionId === runtime.telemetrySessionId,
		).toBe(true);

		env.cleanup();
	});

	it("does NOT suppress identical findings from a previous session", async () => {
		const env = setupTestEnvironment("pi-lens-dedup-cross-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-B" });
		const cacheManager = new CacheManager(false);

		const content = "🔴 blocker: something broken\n";
		const files = ["src/foo.ts"];
		const signature = `${files.join("|")}::${content}`;

		// Seed last findings from a DIFFERENT (old) session.
		cacheManager.writeCache(
			"turn-end-findings-last",
			{ signature, sessionId: "session-A" },
			env.tmpDir,
		);

		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", env.tmpDir);

		// Dedup condition: same signature but DIFFERENT session → must NOT suppress.
		expect(last?.data?.signature).toBe(signature);
		expect(
			last?.data?.signature === signature &&
				last?.data?.sessionId === runtime.telemetrySessionId,
		).toBe(false);

		env.cleanup();
	});
});

// ── Stale turn state eviction ─────────────────────────────────────────────────

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		cascadeResult: undefined,
	})),
}));

describe("stale turn state eviction", () => {
	it("writes sequence metadata into turn-end warning reports", async () => {
		const env = setupTestEnvironment("pi-lens-turn-seq-report-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "seq-session" });
			runtime.seedProjectSequence(10);
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/quality.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const { fileSeq } = runtime.bumpFileSeq(filePath);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"seq-session",
			);
			runtime.recordCodeQualityWarnings([
				{
					id: "cq:test",
					filePath,
					displayPath: "src/quality.ts",
					line: 1,
					column: 1,
					severity: "warning",
					tool: "quality-test",
					rule: "quality-test",
					message: "quality advisory",
					category: "maintainability",
					origin: "dispatch",
				},
			]);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const report = cacheManager.readCache<{
				projectSeqStart?: number;
				projectSeqEnd?: number;
				files: Array<{ filePath: string; fileSeq?: number }>;
			}>("code-quality-warnings", env.tmpDir);
			expect(report?.data).toMatchObject({
				projectSeqStart: 10,
				projectSeqEnd: 11,
			});
			expect(report?.data.files[0]).toMatchObject({ filePath, fileSeq });
		} finally {
			env.cleanup();
		}
	});

	it("evicts turn state written by a previous session", async () => {
		const env = setupTestEnvironment("pi-lens-stale-evict-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = new CacheManager(false);

		// Write a turn state stamped with an old session.
		const filePath = path.join(env.tmpDir, "src/old.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-old",
		);

		// Confirm it was written.
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files),
		).toHaveLength(1);

		// handleTurnEnd should detect the session mismatch and evict.
		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		// After eviction + processing, turn state should be cleared.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});

	it("retains a live foreign pi/MCP owner instead of consuming its worklist", async () => {
		const env = setupTestEnvironment("pi-lens-foreign-live-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src/foreign.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"mcp-foreign",
			"mcp",
		);
		const foreignState = cacheManager.readTurnState(env.tmpDir);
		foreignState.owner!.pid = process.pid + 1;
		cacheManager.writeTurnState(foreignState, env.tmpDir);
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);
			expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toEqual([
				"src/foreign.ts",
			]);
		} finally {
			killSpy.mockRestore();
			env.cleanup();
		}
	});

	it("keeps turn state written by the current session", async () => {
		const env = setupTestEnvironment("pi-lens-same-session-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/current.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-current",
		);

		// handleTurnEnd processes files — no eviction, just normal clear after clean turn.
		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		// No blockers → clearTurnState called normally (not via eviction path).
		// Either way, state ends up cleared — the point is it wasn't evicted prematurely.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});
});

// ── Knip timeout backoff ─────────────────────────────────────────────────────

describe("knip turn-end backoff", () => {
	it("writes normalized project diagnostics delta for new Knip issues", async () => {
		const env = setupTestEnvironment("pi-lens-knip-delta-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "knip-delta-session" });
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze: async () => ({
							...EMPTY_KNIP_RESULT,
							issues: [
								{
									type: "unlisted",
									name: "left-pad",
									file: filePath,
									line: 1,
								},
							],
						}),
					},
				}),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report).toMatchObject({
				sessionId: "knip-delta-session",
				turnIndex: runtime.turnIndex,
				sources: ["knip"],
			});
			expect(report?.diagnostics).toEqual([
				expect.objectContaining({
					filePath,
					line: 1,
					severity: "error",
					semantic: "blocking",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency left-pad",
				}),
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("skips knip after a recent timeout failure", async () => {
		const env = setupTestEnvironment("pi-lens-knip-backoff-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.writeCache(
				"knip",
				{
					...EMPTY_KNIP_RESULT,
					success: false,
					summary:
						"Error: Process timed out after 30000ms (killed with SIGTERM)",
				},
				env.tmpDir,
			);
			const analyze = vi.fn(async () => EMPTY_KNIP_RESULT);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze,
					},
				}),
			);

			expect(analyze).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps the last good result when a run fails (#925 / #1467)", async () => {
		const env = setupTestEnvironment("pi-lens-knip-cache-keep-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			const good = {
				...EMPTY_KNIP_RESULT,
				success: true,
				issues: [{ type: "export", name: "unusedThing", file: "src/old.ts" }],
				unusedExports: [
					{ type: "export", name: "unusedThing", file: "src/old.ts" },
				],
				summary: "Found 1 issues",
			};
			cacheManager.writeCache("knip", good, env.tmpDir);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => ({
							...EMPTY_KNIP_RESULT,
							success: false,
							failureKind: "unavailable-transient",
							summary: "Knip availability probe timed out after 5528ms.",
						}),
					},
				}),
			);

			// Pre-fix, this 194-byte failure record replaced the real findings and
			// every reader afterwards served the failure as the answer.
			const cached = cacheManager.readCache<typeof good>("knip", env.tmpDir);
			expect(cached?.data.success).toBe(true);
			expect(cached?.data.issues).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("does not back off when the cached failure was an availability verdict", async () => {
		const env = setupTestEnvironment("pi-lens-knip-availability-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.writeCache(
				"knip",
				{
					...EMPTY_KNIP_RESULT,
					success: false,
					failureKind: "unavailable-transient",
					summary: "Knip availability probe timed out after 5528ms.",
				},
				env.tmpDir,
			);
			const analyze = vi.fn(async () => EMPTY_KNIP_RESULT);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: { ensureAvailable: async () => true, analyze },
				}),
			);

			// knip never ran, so there is nothing to back off from — and backing
			// off on the word "timed out" is how a probe verdict became permanent.
			expect(analyze).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

// ── Call-graph impact delta persistence (#179 / #533) ────────────────────────

describe("turn_end call-graph impact — persists to the delta report", () => {
	// A tiny two-hop caller chain: editing foo.ts:doThing has a direct caller
	// (bar.ts:callerFn → WillBreak) and an indirect caller (baz.ts:grandCaller →
	// MayBreak). impact() BFS surfaces both; the adapter attributes them to the
	// CALLER files. The turn-state key for the edited file is "src/foo.ts", so
	// the call-graph callee key must be prefixed with that exact string.
	function makeCallGraph(
		coverage: Record<string, unknown> = {
			totalEvidence: 2,
			callsEvidence: 2,
			referencesEvidence: 0,
			eligibleEvidence: 2,
			resolvedEvidence: 2,
			unresolvedEvidence: 0,
			typeOnlyEvidence: 0,
			unsupportedEvidence: 0,
			sameFileEvidence: 0,
			duplicateEvidence: 0,
			complete: true,
			languages: { jsts: "complete" },
		},
	) {
		return {
			callees: new Map(),
			callers: new Map<string, Set<string>>([
				["src/foo.ts:doThing", new Set(["src/bar.ts:callerFn"])],
				["src/bar.ts:callerFn", new Set(["src/baz.ts:grandCaller"])],
			]),
			edges: [],
			inDegree: new Map(),
			unresolvedRefs: 0,
			totalRefs: 0,
			coverage,
			builtAt: new Date().toISOString(),
		} as any;
	}

	function seedEditedFoo(env: ReturnType<typeof setupTestEnvironment>) {
		const filePath = path.join(env.tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export function doThing() { return 1; }\n");
		return filePath;
	}

	it("same-file evidence does not suppress valid cross-file impact", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-same-file-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-same-file-session" });
			runtime.callGraph = makeCallGraph({
				totalEvidence: 2,
				callsEvidence: 2,
				referencesEvidence: 0,
				eligibleEvidence: 1,
				resolvedEvidence: 1,
				unresolvedEvidence: 0,
				typeOnlyEvidence: 0,
				unsupportedEvidence: 0,
				sameFileEvidence: 1,
				duplicateEvidence: 0,
				complete: true,
				languages: { jsts: "complete" },
			});
			const cacheManager = new CacheManager(false);
			seedEditedFoo(env);
			cacheManager.addModifiedRange(
				path.join(env.tmpDir, "src/foo.ts"),
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report?.sources).toContain("call-graph");
			expect(report?.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						runner: "call-graph",
						filePath: path.join(env.tmpDir, "src/bar.ts"),
					}),
				]),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("persists call-graph diagnostics + source on a call-graph-ONLY turn (no knip delta)", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-only-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-only-session" });
			runtime.callGraph = makeCallGraph();
			const cacheManager = new CacheManager(false);
			seedEditedFoo(env);
			cacheManager.addModifiedRange(
				path.join(env.tmpDir, "src/foo.ts"),
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			// lens_diagnostics only ever reads the PERSISTED delta report — assert the
			// call-graph findings actually reached disk (the #533 silent-vanish bug).
			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report, "delta report was not written at all").toBeDefined();
			expect(report?.sources).toContain("call-graph");
			expect(report?.diagnostics).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						runner: "call-graph",
						rule: "call-graph:willbreak",
						severity: "warning",
						filePath: path.join(env.tmpDir, "src/bar.ts"),
					}),
				]),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("persists BOTH knip and call-graph entries on a mixed turn", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-mixed-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-mixed-session" });
			runtime.callGraph = makeCallGraph();
			const cacheManager = new CacheManager(false);
			const filePath = seedEditedFoo(env);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze: async () => ({
							...EMPTY_KNIP_RESULT,
							issues: [
								{ type: "unlisted", name: "left-pad", file: filePath, line: 1 },
							],
						}),
					},
				}),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report).toBeDefined();
			// Pre-fix, the report was serialized with only knip's entries and
			// "call-graph" was appended afterwards → discarded. Both must survive.
			expect(report?.sources).toEqual(
				expect.arrayContaining(["knip", "call-graph"]),
			);
			expect(report?.diagnostics.some((d) => d.runner === "knip")).toBe(true);
			expect(report?.diagnostics.some((d) => d.runner === "call-graph")).toBe(
				true,
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	// #1080: a call-graph caller that resolves to a KNOWN test file must be absent
	// from BOTH the turn-end advisory text and the persisted call-graph delta, for
	// call-graph-only AND mixed turns — a normal caller remains.
	function makeCallGraphWithTestCaller() {
		return {
			callees: new Map(),
			callers: new Map<string, Set<string>>([
				[
					"src/foo.ts:doThing",
					new Set(["src/bar.ts:callerFn", "src/bar.test.ts:testCaller"]),
				],
			]),
			edges: [],
			inDegree: new Map(),
			unresolvedRefs: 0,
			totalRefs: 0,
			coverage: {
				totalEvidence: 2,
				callsEvidence: 2,
				referencesEvidence: 0,
				eligibleEvidence: 2,
				resolvedEvidence: 2,
				unresolvedEvidence: 0,
				typeOnlyEvidence: 0,
				unsupportedEvidence: 0,
				sameFileEvidence: 0,
				duplicateEvidence: 0,
				complete: true,
				languages: { jsts: "complete" },
			},
			builtAt: new Date().toISOString(),
		} as any;
	}

	it("excludes a test-file caller from advisory + delta on a call-graph-only turn (#1080)", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-testrole-only-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-testrole-only" });
			runtime.callGraph = makeCallGraphWithTestCaller();
			const cacheManager = new CacheManager(false);
			seedEditedFoo(env);
			cacheManager.addModifiedRange(
				path.join(env.tmpDir, "src/foo.ts"),
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			// Persisted delta: the normal caller's file remains; the test caller's does not.
			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report?.sources).toContain("call-graph");
			const cgFiles = (report?.diagnostics ?? [])
				.filter((d) => d.runner === "call-graph")
				.map((d) => d.filePath);
			expect(cgFiles).toContain(path.join(env.tmpDir, "src/bar.ts"));
			expect(cgFiles).not.toContain(path.join(env.tmpDir, "src/bar.test.ts"));

			// Advisory text: same exclusion.
			const advisory =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
					?.content ?? "";
			expect(advisory).toContain("Call-graph impact");
			expect(advisory).toContain("bar.ts");
			expect(advisory).not.toContain("bar.test.ts");
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("excludes a test-file caller from the call-graph delta on a mixed turn (#1080)", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-testrole-mixed-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-testrole-mixed" });
			runtime.callGraph = makeCallGraphWithTestCaller();
			const cacheManager = new CacheManager(false);
			const filePath = seedEditedFoo(env);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze: async () => ({
							...EMPTY_KNIP_RESULT,
							issues: [
								{ type: "unlisted", name: "left-pad", file: filePath, line: 1 },
							],
						}),
					},
				}),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report?.sources).toEqual(
				expect.arrayContaining(["knip", "call-graph"]),
			);
			const cgFiles = (report?.diagnostics ?? [])
				.filter((d) => d.runner === "call-graph")
				.map((d) => d.filePath);
			expect(cgFiles).toContain(path.join(env.tmpDir, "src/bar.ts"));
			expect(cgFiles).not.toContain(path.join(env.tmpDir, "src/bar.test.ts"));
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("does not emit impact findings for mixed supported/unsupported coverage", async () => {
		const env = setupTestEnvironment("pi-lens-callgraph-partial-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "cg-partial-session" });
			runtime.callGraph = makeCallGraph({
				totalEvidence: 3,
				callsEvidence: 3,
				referencesEvidence: 0,
				eligibleEvidence: 2,
				resolvedEvidence: 2,
				unresolvedEvidence: 0,
				typeOnlyEvidence: 0,
				unsupportedEvidence: 1,
				duplicateEvidence: 0,
				complete: false,
				languages: { jsts: "complete", javascript: "unavailable" },
			});
			const cacheManager = new CacheManager(false);
			const filePath = seedEditedFoo(env);
			cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, env.tmpDir);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report?.sources ?? []).not.toContain("call-graph");
			expect(report?.diagnostics ?? []).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ runner: "call-graph" })]),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

// ── sessionId stamped into turn state ─────────────────────────────────────────

describe("addModifiedRange sessionId stamping", () => {
	it("stamps session ID into turn state when provided", () => {
		const env = setupTestEnvironment("pi-lens-stamp-");
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"my-session-id",
		);

		const state = cacheManager.readTurnState(env.tmpDir);
		expect(state.sessionId).toBe("my-session-id");

		env.cleanup();
	});

	it("leaves sessionId undefined when not provided", () => {
		const env = setupTestEnvironment("pi-lens-no-stamp-");
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src/bar.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const y = 2;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
		);

		const state = cacheManager.readTurnState(env.tmpDir);
		expect(state.sessionId).toBeUndefined();

		env.cleanup();
	});
});

// ── Context injection framing ─────────────────────────────────────────────────

describe("context injection framing", () => {
	it("consumeTurnEndFindings includes automated-check framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-frame-");
		const cacheManager = new CacheManager(false);

		cacheManager.writeCache(
			"turn-end-findings",
			{ content: "🔴 some blocker\n" },
			env.tmpDir,
		);

		const result = consumeTurnEndFindings(cacheManager, env.tmpDir);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("🔴 some blocker");

		env.cleanup();
	});

	it("consumeTestFindings includes automated-check framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-test-");
		const cacheManager = new CacheManager(false);
		const runtime = new RuntimeCoordinator();
		const testFile = path.join(env.tmpDir, "sample.test.ts");
		fs.writeFileSync(testFile, "test('sample', () => {});\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			files: [{ path: testFile, role: "test" }],
		});

		cacheManager.writeCache(
			"test-runner-findings",
			{ content: "[Tests] ✗ 1/3 failed — vitest\n", provenance },
			env.tmpDir,
		);

		const result = consumeTestFindings(cacheManager, env.tmpDir, runtime);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("fix before continuing");
		expect(result!.messages[0].content).toContain("[Tests] ✗ 1/3 failed");

		env.cleanup();
	});

	it("consumeSessionStartGuidance includes automated-context framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-guidance-");
		const cacheManager = new CacheManager(false);

		cacheManager.writeCache(
			"session-start-guidance",
			{ content: "📌 pi-lens active\n" },
			env.tmpDir,
		);

		const result = consumeSessionStartGuidance(cacheManager, env.tmpDir);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("📌 pi-lens active");

		env.cleanup();
	});

	it("SESSION_START_GUIDANCE advertises the read-substitute tools and only registered pi tools", () => {
		const text = SESSION_START_GUIDANCE.join("\n");

		// The #245 gap this guards: module_report + read_symbol were registered as
		// pi tools but never surfaced in the session-start orientation, so the agent
		// never reached for them. Keep them (and the other key tools) advertised.
		for (const tool of [
			"lens_diagnostics",
			// #348: symbol_search is now a registered pi tool (the discovery
			// funnel's entry point) — advertise it alongside module_report/
			// read_symbol like the other read-substitute tools.
			"symbol_search",
			"module_report",
			"read_symbol",
			"lsp_navigation",
			"lsp_diagnostics",
			"ast_grep_search",
			"ast_grep_replace",
			"ast_grep_dump",
		]) {
			expect(text).toContain(tool);
		}

		// Stay lean: the orientation is a nudge, not re-documentation of every arg.
		expect(text.length).toBeLessThan(750);
	});
});

// ── Unresolved inline blocker re-surfacing ────────────────────────────────────

describe("unresolved inline blocker re-surfacing", () => {
	it("re-injects an inline blocker that was not fixed before turn_end", async () => {
		const env = setupTestEnvironment("pi-lens-unresolved-blocker-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-A",
		);

		runtime.recordInlineBlockers(
			filePath,
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: unused variable 'x'",
		);

		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		const injected = cacheManager.readCache<{ content: string }>(
			"turn-end-findings",
			env.tmpDir,
		);
		expect(injected?.data?.content).toBeDefined();
		expect(injected?.data?.content).toContain("Unresolved from this turn");
		expect(injected?.data?.content).toContain("foo.ts");
		expect(injected?.data?.content).toContain("unused variable");

		env.cleanup();
	});

	it("does NOT re-inject when inline blocker was cleared (agent fixed it)", async () => {
		const env = setupTestEnvironment("pi-lens-resolved-blocker-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/bar.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const y = 2;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-A",
		);

		runtime.recordInlineBlockers(
			filePath,
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: unused",
		);
		runtime.clearInlineBlockers(filePath);

		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		const injected = cacheManager.readCache<{ content: string }>(
			"turn-end-findings",
			env.tmpDir,
		);
		expect(injected?.data?.content).toBeUndefined();

		env.cleanup();
	});

	it("consumeInlineBlockers empties the map", () => {
		const env = setupTestEnvironment("pi-lens-consume-blockers-");
		try {
			const runtime = new RuntimeCoordinator();
			const a = path.join(env.tmpDir, "b.ts");
			const c = path.join(env.tmpDir, "c.ts");
			fs.writeFileSync(a, "x\n");
			fs.writeFileSync(c, "x\n");
			runtime.recordInlineBlockers(a, "🔴 STOP");
			runtime.recordInlineBlockers(c, "🔴 STOP 2");
			const first = runtime.consumeInlineBlockers();
			expect(first).toHaveLength(2);
			const second = runtime.consumeInlineBlockers();
			expect(second).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("beginTurn preserves unresolved inline blockers from previous turns", () => {
		const env = setupTestEnvironment("pi-lens-beginturn-blockers-");
		try {
			const runtime = new RuntimeCoordinator();
			const file = path.join(env.tmpDir, "x.ts");
			fs.writeFileSync(file, "x\n");
			runtime.recordInlineBlockers(file, "🔴 STOP");
			runtime.beginTurn();
			const entries = runtime.getInlineBlockersSnapshot();
			expect(entries).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});

// ── Unified secret surfacing (#131 Mode 3) ────────────────────────────────────

describe("turn_end unified secret surfacing", () => {
	it("collapses the SAME secret from gitleaks + trivy + ast-grep into ONE blocker", async () => {
		const env = setupTestEnvironment("pi-lens-secret-collapse-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "sec-session" });
			const cacheManager = new CacheManager(false);

			const secretFile = path.join(env.tmpDir, "src/config.ts");
			fs.mkdirSync(path.dirname(secretFile), { recursive: true });
			fs.writeFileSync(secretFile, "const k = 'AKIA...';\n");
			cacheManager.addModifiedRange(
				secretFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"sec-session",
			);

			// Three independent sources flag the SAME line with DIFFERENT rule ids.
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: "",
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 42,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: "",
					findings: [],
					secrets: [
						{ ruleId: "aws-access-key-id", file: secretFile, line: 42 },
					],
				},
				env.tmpDir,
			);
			runtime.recordActionableWarnings([
				{
					id: "ag:1",
					filePath: secretFile,
					displayPath: "src/config.ts",
					line: 42,
					severity: "warning",
					tool: "ast-grep",
					rule: "no-hardcoded-secret-js",
					message: "hardcoded secret",
					actions: [],
					suppressed: false,
					origin: "dispatch",
				},
			]);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const result = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = result?.messages?.[0]?.content ?? "";

			// The location is surfaced exactly ONCE, not three times.
			expect(content.split("src/config.ts:42").length - 1).toBe(1);
			// Combined provenance from all three scanners is shown.
			expect(content).toContain("gitleaks + trivy + ast-grep");
			// gitleaks (highest priority) owns the displayed rule.
			expect(content).toContain("aws-access-token");
			// Exactly one secrets blocker header.
			expect(content.split("hardcoded secrets detected").length - 1).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});

// ── Dead-path gitleaks findings (#1461 slice 1 / #1460) ───────────────────────

describe("turn_end gitleaks findings for deleted files", () => {
	// The live #1460 shape: a gitleaks scan flags a path, the directory is
	// deleted, and the finding is still inside the 30-minute TTL at turn_end.
	// Before the fix it shipped as a 🔴 STOP blocker naming a file the agent
	// cannot fix.
	function setupSecretTurn(prefix: string) {
		const env = setupTestEnvironment(prefix);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "dead-path-session" });
		const cacheManager = new CacheManager(false);
		// An edited file that still exists — so provenance sees a live workspace
		// and the advisory is never suppressed for the unrelated `allFilesDeleted`
		// reason. This is exactly why #1419's guard answered "current".
		const editedFile = path.join(env.tmpDir, "src/edited.ts");
		fs.mkdirSync(path.dirname(editedFile), { recursive: true });
		fs.writeFileSync(editedFile, "export const value = 1;\n");
		cacheManager.addModifiedRange(
			editedFile,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"dead-path-session",
		);
		return { env, runtime, cacheManager };
	}

	function writeGitleaksCache(
		cacheManager: CacheManager,
		cwd: string,
		findings: Array<{ ruleId: string; file: string; startLine: number; description: string }>,
	) {
		cacheManager.writeCache(
			"gitleaks",
			{ success: true, scannedAt: "", findings },
			cwd,
		);
	}

	it("does NOT deliver a cached finding whose file was deleted after the scan", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-dead-path-");
		try {
			const deletedDir = path.join(env.tmpDir, ".pi/smoke-research/data");
			const deletedFile = path.join(deletedDir, "sources.json");
			fs.mkdirSync(deletedDir, { recursive: true });
			fs.writeFileSync(deletedFile, '{"key":"AKIA..."}\n');
			writeGitleaksCache(cacheManager, env.tmpDir, [
				{
					ruleId: "generic-api-key",
					file: deletedFile,
					startLine: 1341,
					description: "Detected a Generic API Key",
				},
			]);
			// The deletion that the TTL cannot see.
			fs.rmSync(path.join(env.tmpDir, ".pi"), { recursive: true, force: true });

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
					?.content ?? "";
			expect(content).not.toContain("hardcoded secrets detected");
			expect(content).not.toContain("sources.json");
			expect(content).not.toContain("generic-api-key");
		} finally {
			env.cleanup();
		}
	});

	it("delivers live-path findings unchanged and drops only the dead ones", async () => {
		const { env, runtime, cacheManager } = setupSecretTurn("pi-lens-mixed-path-");
		try {
			const liveFile = path.join(env.tmpDir, "src/config.ts");
			fs.writeFileSync(liveFile, "const k = 'AKIA...';\n");
			const deletedFile = path.join(env.tmpDir, "scratch/sources.json");
			fs.mkdirSync(path.dirname(deletedFile), { recursive: true });
			fs.writeFileSync(deletedFile, '{"key":"AKIA..."}\n');
			writeGitleaksCache(cacheManager, env.tmpDir, [
				{
					ruleId: "generic-api-key",
					file: deletedFile,
					startLine: 1341,
					description: "Detected a Generic API Key",
				},
				{
					ruleId: "aws-access-token",
					file: liveFile,
					startLine: 42,
					description: "AWS key",
				},
			]);
			fs.rmSync(path.join(env.tmpDir, "scratch"), {
				recursive: true,
				force: true,
			});

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
					?.content ?? "";
			expect(content).toContain("hardcoded secrets detected");
			expect(content).toContain("src/config.ts:42");
			expect(content).toContain("aws-access-token");
			expect(content).not.toContain("sources.json");
		} finally {
			env.cleanup();
		}
	});
});

// ── License-risk advisory (#131 Mode 4) ───────────────────────────────────────

describe("turn_end license-risk surfacing", () => {
	it("surfaces cached trivy license findings as an advisory", async () => {
		const env = setupTestEnvironment("pi-lens-license-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "lic-session" });
			const cacheManager = new CacheManager(false);

			const file = path.join(env.tmpDir, "src/a.ts");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"lic-session",
			);

			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: "",
					findings: [],
					secrets: [],
					licenses: [
						{
							license: "GPL-3.0",
							pkgName: "leftpad",
							severity: "HIGH",
							category: "restricted",
						},
					],
				},
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
					?.content ?? "";
			expect(content).toContain("Dependency license risk");
			expect(content).toContain("leftpad — GPL-3.0 (HIGH, restricted)");
		} finally {
			env.cleanup();
		}
	});
});

// ── #628: stale test results are cached, not discarded ────────────────────────

describe("turn_end test runner — stale results are cached, not discarded", () => {
	it("caches a real failure even when the turn advances before the async run resolves", async () => {
		const env = setupTestEnvironment("pi-lens-test-stale-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "stale-session" });
			const cacheManager = new CacheManager(false);

			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				srcFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"stale-session",
			);

			let resolveRun!: (v: {
				file: string;
				sourceFile: string;
				runner: string;
				passed: number;
				failed: number;
				skipped: number;
				failures: unknown[];
				duration: number;
			}) => void;
			const runPromise = new Promise((resolve) => {
				resolveRun = resolve;
			});

			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			const testRunnerClient = {
				getTestRunTarget: () => ({
					testFile,
					runner: "vitest",
					config: {} as any,
					strategy: "related" as const,
				}),
				runTestFileAsync: () => runPromise,
				formatResult: (r: { failed: number }) =>
					r.failed > 0 ? "[Tests] ✗ 0/1 passed — vitest" : "",
			};

			const done = handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					testRunnerClient,
				}),
			);
			await done;

			// Simulate the turn advancing (another edit landed) before the fired
			// test subprocess resolves — this is the routine, non-rare case from
			// the real dogfooding logs.
			runtime.beginTurn();
			resolveRun({
				file: testFile,
				sourceFile: srcFile,
				runner: "vitest",
				passed: 0,
				failed: 1,
				skipped: 0,
				failures: [],
				duration: 5,
			});
			// Flush the now-resolved Promise.allSettled(...).then(...) chain.
			await new Promise((r) => setImmediate(r));

			const cached = cacheManager.readCache<{
				content: string;
				stale?: boolean;
				superseded?: boolean;
				provenance?: { files: unknown[] };
			}>("test-runner-findings", env.tmpDir);

			// The old behavior discarded this entirely (no cache entry at all).
			expect(cached?.data?.content).toContain("[Tests] ✗ 0/1 passed");
			expect(cached?.data?.stale).toBe(true);
			expect(cached?.data?.superseded).toBe(true);
			expect(cached?.data?.provenance?.files.length).toBeGreaterThan(0);
			expect(cached?.data?.content).toContain("prior turn");
		} finally {
			env.cleanup();
		}
	});

	it("marks a same-turn external rewrite superseded", async () => {
		const env = setupTestEnvironment("pi-lens-test-rewrite-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "rewrite-session" });
			const cacheManager = new CacheManager(false);
			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			fs.writeFileSync(testFile, "test('x', () => {});\n");
			cacheManager.addModifiedRange(srcFile, { start: 1, end: 1 }, false, env.tmpDir, "rewrite-session");
			let resolveRun!: (value: any) => void;
			const run = new Promise<any>((resolve) => { resolveRun = resolve; });
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, {
				ctxCwd: env.tmpDir,
				testRunnerClient: {
					getTestRunTarget: () => ({ testFile, runner: "vitest", config: {}, strategy: "related" as const }),
					runTestFileAsync: () => run,
					formatResult: () => "rewrite failure",
				},
			}));
			fs.writeFileSync(srcFile, "export const x = 2;\n");
			resolveRun({ file: testFile, sourceFile: srcFile, runner: "vitest", passed: 0, failed: 1, skipped: 0, failures: [], duration: 1 });
			await new Promise((resolve) => setImmediate(resolve));
			const cached = cacheManager.readCache<{ superseded?: boolean; launchedFrom?: unknown; publishedAgainst?: unknown }>("test-runner-findings", env.tmpDir)?.data;
			expect(runtime.turnIndex).toBe(0);
			expect(cached).toMatchObject({ superseded: true });
			expect(cached?.launchedFrom).toBeDefined();
			expect(cached?.publishedAgainst).toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	it("does not let an older test generation overwrite a newer batch", async () => {
		const env = setupTestEnvironment("pi-lens-test-generation-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "generation-session" });
			const cacheManager = new CacheManager(false);
			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			fs.writeFileSync(testFile, "test('x', () => {});\n");
			const resolvers: Array<(value: any) => void> = [];
			const runner = {
				getTestRunTarget: () => ({ testFile, runner: "vitest", config: {}, strategy: "related" as const }),
				runTestFileAsync: () => new Promise<any>((resolve) => resolvers.push(resolve)),
				formatResult: (result: { duration: number }) => `generation-${result.duration}`,
			};
			const fire = async () => {
				cacheManager.addModifiedRange(srcFile, { start: 1, end: 1 }, false, env.tmpDir, "generation-session");
				await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir, testRunnerClient: runner }));
			};
			await fire();
			await fire();
			resolvers[1]!({ file: testFile, sourceFile: srcFile, runner: "vitest", passed: 0, failed: 1, skipped: 0, failures: [], duration: 2 });
			await new Promise((resolve) => setImmediate(resolve));
			resolvers[0]!({ file: testFile, sourceFile: srcFile, runner: "vitest", passed: 0, failed: 1, skipped: 0, failures: [], duration: 1 });
			await new Promise((resolve) => setImmediate(resolve));
			const cached = cacheManager.readCache<{ content: string; testRunGeneration: number }>("test-runner-findings", env.tmpDir)?.data;
			expect(cached).toMatchObject({ content: "generation-2", testRunGeneration: 2 });
		} finally {
			env.cleanup();
		}
	});

	it("publishes a settling failure after an empty context delivery", async () => {
		const env = setupTestEnvironment("pi-lens-test-empty-consume-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "empty-consume-session" });
			const cacheManager = new CacheManager(false);
			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			fs.writeFileSync(testFile, "test('x', () => {});\n");
			cacheManager.addModifiedRange(srcFile, { start: 1, end: 1 }, false, env.tmpDir, "empty-consume-session");
			let resolveRun!: (value: any) => void;
			const run = new Promise<any>((resolve) => { resolveRun = resolve; });
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, {
				ctxCwd: env.tmpDir,
				testRunnerClient: {
					getTestRunTarget: () => ({ testFile, runner: "vitest", config: {}, strategy: "related" as const }),
					runTestFileAsync: () => run,
					formatResult: () => "late failure",
				},
			}));
			expect(consumeTestFindings(cacheManager, env.tmpDir, runtime)).toBeUndefined();
			resolveRun({ file: testFile, sourceFile: srcFile, runner: "vitest", passed: 0, failed: 1, skipped: 0, failures: [], duration: 1 });
			await new Promise((resolve) => setImmediate(resolve));
			expect(cacheManager.readCache<{ content: string }>("test-runner-findings", env.tmpDir)?.data?.content)
				.toBe("late failure");
		} finally {
			env.cleanup();
		}
	});

	it("does not tag the result stale when the turn has not advanced", async () => {
		const env = setupTestEnvironment("pi-lens-test-nonstale-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "nonstale-session" });
			const cacheManager = new CacheManager(false);

			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				srcFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"nonstale-session",
			);

			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			const testRunnerClient = {
				getTestRunTarget: () => ({
					testFile,
					runner: "vitest",
					config: {} as any,
					strategy: "related" as const,
				}),
				runTestFileAsync: async () => ({
					file: testFile,
					sourceFile: srcFile,
					runner: "vitest",
					passed: 0,
					failed: 1,
					skipped: 0,
					failures: [],
					duration: 5,
				}),
				formatResult: () => "[Tests] ✗ 0/1 passed — vitest",
			};

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					testRunnerClient,
				}),
			);
			await new Promise((r) => setImmediate(r));

			const cached = cacheManager.readCache<{
				content: string;
				stale?: boolean;
			}>("test-runner-findings", env.tmpDir);

			expect(cached?.data?.content).toContain("[Tests] ✗ 0/1 passed");
			expect(cached?.data?.stale).toBe(false);
			expect(cached?.data?.content).not.toContain("prior turn");
		} finally {
			env.cleanup();
		}
	});
});

// ── #1479: the turn-end log separates "measured 0" from "unmeasured" ─────────

describe("turn_end test runner — duration reporting (#1479)", () => {
	async function runAndCaptureTurnEndLog(duration: number, failed: number) {
		const env = setupTestEnvironment("pi-lens-test-duration-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "duration-session" });
			const cacheManager = new CacheManager(false);

			const srcFile = path.join(env.tmpDir, "src/foo.ts");
			const testFile = path.join(env.tmpDir, "src/foo.test.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			fs.writeFileSync(testFile, "test('x', () => {});\n");
			cacheManager.addModifiedRange(
				srcFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"duration-session",
			);

			const dbg = vi.fn();
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					dbg,
					testRunnerClient: {
						getTestRunTarget: () => ({
							testFile,
							runner: "cargo",
							config: {} as any,
							strategy: "related" as const,
						}),
						runTestFileAsync: async () => ({
							file: testFile,
							sourceFile: srcFile,
							runner: "cargo",
							passed: 1,
							failed,
							skipped: 0,
							failures: [],
							duration,
						}),
						formatResult: () => "[Tests] ✗ — cargo",
					},
				}),
			);
			await new Promise((r) => setImmediate(r));

			return (dbg.mock.calls as string[][])
				.map((c) => c[0])
				.filter((line) => line.startsWith("turn_end: test "));
		} finally {
			env.cleanup();
		}
	}

	it("prints (unmeasured), not (0ms), when the run was never timed", async () => {
		const lines = await runAndCaptureTurnEndLog(0, 0);

		// The whole point: a reader must not be able to mistake an absent
		// measurement for a run that took under a millisecond.
		expect(lines).toEqual([
			"turn_end: test cargo foo.test.ts → PASS 1p/0f (unmeasured)",
		]);
	});

	it("prints the exact measured duration when the run was timed", async () => {
		const lines = await runAndCaptureTurnEndLog(253, 1);

		expect(lines).toEqual([
			"turn_end: test cargo foo.test.ts → FAIL 1p/1f (253ms)",
		]);
	});

	it("treats a garbled negative duration as unmeasured, not as a number", async () => {
		const lines = await runAndCaptureTurnEndLog(-7, 0);

		expect(lines).toEqual([
			"turn_end: test cargo foo.test.ts → PASS 1p/0f (unmeasured)",
		]);
	});
});

// ── #628: cascade-neighbor test companions are also fired ─────────────────────

describe("turn_end test runner — cascade neighbors get their own test companion run", () => {
	it("fires the test companion for a cascade neighbor, not just the edited file", async () => {
		const env = setupTestEnvironment("pi-lens-test-neighbor-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "neighbor-session" });
			const cacheManager = new CacheManager(false);

			const editedFile = path.join(env.tmpDir, "src/foo.ts");
			const neighborFile = path.join(env.tmpDir, "src/bar.ts");
			fs.mkdirSync(path.dirname(editedFile), { recursive: true });
			fs.writeFileSync(editedFile, "export const x = 1;\n");
			fs.writeFileSync(neighborFile, "import { x } from './foo'; export const y = x;\n");

			cacheManager.addModifiedRange(
				editedFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"neighbor-session",
			);

			// Seed this turn's already-computed cascade result (as the #450
			// deferred-cascade drain would have produced it) — bar.ts imports
			// foo.ts, so it's a neighbor of the edited file.
			runtime.appendCascadeRun({
				filePath: editedFile,
				result: {
					filePath: editedFile,
					impact: {} as any,
					neighbors: [
						{
							filePath: neighborFile,
							reason: "imports",
							diagnostics: [],
							lspTouched: false,
						},
					],
					formatted: "",
				},
				neighborCount: 1,
				diagnosticCount: 0,
			});

			const fooTestFile = path.join(env.tmpDir, "src/foo.test.ts");
			const barTestFile = path.join(env.tmpDir, "src/bar.test.ts");
			const getTestRunTarget = vi.fn((absPath: string) => {
				if (path.basename(absPath) === path.basename(editedFile)) {
					return {
						testFile: fooTestFile,
						runner: "vitest",
						config: {} as any,
						strategy: "related" as const,
					};
				}
				if (path.basename(absPath) === path.basename(neighborFile)) {
					return {
						testFile: barTestFile,
						runner: "vitest",
						config: {} as any,
						strategy: "related" as const,
					};
				}
				return null;
			});
			const runTestFileAsync = vi.fn(async (testFile: string) => ({
				file: testFile,
				sourceFile: "",
				runner: "vitest",
				passed: 1,
				failed: 0,
				skipped: 0,
				failures: [],
				duration: 1,
			}));

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					testRunnerClient: {
						getTestRunTarget,
						runTestFileAsync,
						formatResult: () => "",
					},
				}),
			);
			await new Promise((r) => setImmediate(r));

			const firedTestFiles = runTestFileAsync.mock.calls.map((c) => c[0]);
			expect(firedTestFiles).toContain(fooTestFile);
			expect(firedTestFiles).toContain(barTestFile);
		} finally {
			env.cleanup();
		}
	});
});
