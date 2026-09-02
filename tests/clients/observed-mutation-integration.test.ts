/**
 * #2430 acceptance — an unknown tool with a `path` field reaches the pipeline.
 *
 * These cases drive the production entry points (`handleToolCall`,
 * `handleToolResult`) against a real `CacheManager`, a real
 * `RuntimeCoordinator` and a real mutation bridge, and assert on
 * `turn-state.json` and the change log. Nothing here imports a helper that
 * only the fix defines, so each case fails on an ASSERTION against pre-fix
 * code rather than on a missing module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import { classifyMutatingTool } from "../../clients/mutating-tool.js";
import {
	MUTATION_BRIDGE_KEY,
	registerMutationBridge,
} from "../../clients/mutation-bridge.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	MUTATION_ATTRIBUTION_FILE,
	primePersistedMutationAttribution,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import {
	armObservedMutation,
	resetObservedMutationNet,
} from "../../clients/observed-mutation.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { countFileLines } from "../../clients/read-guard-tool-lines.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	})),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		touchFile: vi.fn(async () => undefined),
		getWarmClientForFile: vi.fn(async () => undefined),
		getOpenDocumentPaths: () => [],
	}),
	resetLSPService: () => {},
	notifyExternalFileChange: vi.fn(async () => undefined),
}));

vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => [], formatWarnings: () => "" },
	}),
}));

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

/**
 * The bridge is a process-global, first-wins singleton, so it is mounted once
 * per test FILE (vitest's forks pool gives each file its own process) over
 * mutable holders the individual cases swap.
 */
let liveRuntime: RuntimeCoordinator | undefined;
let liveCacheManager: CacheManager | undefined;
let liveRoot = "";

if (!(MUTATION_BRIDGE_KEY in (globalThis as object))) {
	registerMutationBridge({
		getRuntime: () => liveRuntime as never,
		getCacheManager: () => liveCacheManager as never,
		getProjectRoot: () => liveRoot,
		getDispatchCwd: () => liveRoot,
		countFileLines,
		isRecordable: () => true,
		dbg: () => {},
	});
}

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
});

function patchEvent(
	filePath: string,
	toolCallId: string,
): Record<string, unknown> {
	// A tool pi-lens has never met: an unknown NAME, and an input shape no
	// adapter in `MUTATION_SHAPE_ADAPTERS` recognizes. The only thing the seam
	// can see is that it names a file.
	return {
		toolName: "patch_file",
		toolCallId,
		input: { path: filePath, patch: "@@ -2 +2 @@" },
		content: [{ type: "text", text: "patched" }],
	};
}

/**
 * An unknown tool that also states the text it replaced. The NAME is unknown
 * and the SHAPE is not one an adapter shipped in `MUTATION_SHAPE_ADAPTERS`
 * recognizes, so the call is unclassified until the observational net
 * attributes it — but its input carries the `oldText`/`newText` pair the
 * #2402 applied-edit records are built from, which is what makes the skip
 * path's partial-apply step observable (#2449 review round 4, S4).
 */
function retryEvent(
	filePath: string,
	toolCallId: string,
): Record<string, unknown> {
	return {
		toolName: "patch_retry",
		toolCallId,
		input: {
			path: filePath,
			patch: "@@ -2 +2 @@",
			oldText: "const a = 1;",
			newText: "const a = 9;",
		},
		content: [{ type: "text", text: "patched" }],
	};
}

function toolCallDeps(args: {
	event: Record<string, unknown>;
	cwd: string;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolCall>[0] {
	return {
		event: args.event,
		ctx: { cwd: args.cwd },
		lensEnabled: true,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
	} as unknown as Parameters<typeof handleToolCall>[0];
}

function toolResultDeps(args: {
	event: Record<string, unknown>;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolResult>[0] {
	return {
		event: args.event,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

function newSession(tmpDir: string): {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
} {
	const cacheManager = new CacheManager(false);
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmpDir;
	runtime.setTelemetryIdentity({ sessionId: "s-2430" });
	runtime.beginTurn();
	liveRuntime = runtime;
	liveCacheManager = cacheManager;
	liveRoot = tmpDir;
	return { runtime, cacheManager };
}

describe("#2430 acceptance 1 — the FIRST call of an unknown tool lands in turn state", () => {
	it("observes the write and records it as an edit with the tool's own attribution", async () => {
		const env = setupTestEnvironment("pi-lens-2430-first-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "observed.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const event = patchEvent(filePath, "call-2430-first");
			await handleToolCall(
				toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
			);

			// The unknown tool executes and rewrites line 2.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 222;", "const c = 3;", ""].join("\n"),
			);

			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const turnState = cacheManager.readTurnState(env.tmpDir);
			const files = Object.keys(turnState.files ?? {});
			expect(files.length).toBeGreaterThan(0);
			expect(files.some((entry) => entry.includes("observed.ts"))).toBe(true);

			// The change log names the tool rather than collapsing onto agent-edit.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:patch_file" },
			]);

			// Deferred, never immediate — an unknown edit-shaped tool takes the
			// safe timing, so the agent_settled drain formats it.
			expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 acceptance 2 — the SECOND call is classified without a snapshot", () => {
	it("classifies the same tool by name once one mutation has been observed", async () => {
		const env = setupTestEnvironment("pi-lens-2430-second-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "twice.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const first = patchEvent(filePath, "call-2430-a");
			// Before any observation the seam has no opinion at all: this is the
			// #2423 gap #2430 exists to close.
			expect(classifyMutatingTool(first)).toBeUndefined();

			await handleToolCall(
				toolCallDeps({ event: first, cwd: env.tmpDir, runtime, cacheManager }),
			);
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await handleToolResult(
				toolResultDeps({ event: first, runtime, cacheManager }),
			);

			const second = patchEvent(filePath, "call-2430-b");
			expect(classifyMutatingTool(second)).toMatchObject({
				toolName: "patch_file",
				kind: "edit",
				provenance: "learned",
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 acceptance 2 — persistence is reachable on the PRODUCTION path", () => {
	it("persists after two real arm/settle cycles, and a fresh session classifies from disk", async () => {
		// #2449 review round 2, F2. The pre-round test for this criterion called
		// `noteObservedMutation` twice DIRECTLY, so it proved the counter and
		// nothing about the path — and the path could not reach two, because
		// `shouldArmObservationForTool` latched off the moment the tool became
		// session-learned. `PERSIST_AFTER_OBSERVATIONS = 2` was unreachable and
		// no attribution ever reached disk for the next session to adopt.
		//
		// Every step here goes through `handleToolCall`/`handleToolResult`.
		const env = setupTestEnvironment("pi-lens-2430-persist-path-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "persisted.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
			].entries()) {
				const event = patchEvent(filePath, `call-2430-persist-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);
			}

			const attributionFile = path.join(
				getProjectDataDir(env.tmpDir),
				MUTATION_ATTRIBUTION_FILE,
			);
			expect(fs.existsSync(attributionFile)).toBe(true);
			expect(
				JSON.parse(fs.readFileSync(attributionFile, "utf-8")),
			).toMatchObject({
				version: 1,
				tools: [{ name: "patch_file", observations: 2 }],
			});

			// A FRESH session: nothing in memory, only the file on disk.
			resetMutationAttribution();
			resetObservedMutationNet();
			expect(
				classifyMutatingTool(patchEvent(filePath, "call-2430-fresh")),
			).toBeUndefined();

			primePersistedMutationAttribution(env.tmpDir);
			expect(
				classifyMutatingTool(patchEvent(filePath, "call-2430-fresh")),
			).toMatchObject({
				kind: "edit",
				provenance: "learned",
				source: "attribution:persisted",
			});
			// And a durably attributed tool is never watched again.
			expect(shouldArmObservationForTool("patch_file")).toBe(false);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2449 review round 3 — one receipt per physical edit", () => {
	it("records a provisionally-learned tool once, not once per half", async () => {
		// S2. A tool learned from ONE observation is classified by NAME from the
		// next call on, and is STILL armed — that second property is what makes
		// `PERSIST_AFTER_OBSERVATIONS = 2` reachable at all (round 2, F2). Both
		// halves then recorded the same edit: the settle replayed it through the
		// mutation bridge with measured ranges, and the classification chain
		// below recorded it AGAIN as a whole-file change. Three real edits
		// produced four change-log receipts, and the middle one was reported
		// twice with two different ranges.
		const env = setupTestEnvironment("pi-lens-2449-double-record-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "thrice.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			for (const [index, body] of [
				`${SOURCE}const d = 4;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\n`,
				`${SOURCE}const d = 4;\nconst e = 5;\nconst f = 6;\n`,
			].entries()) {
				const event = patchEvent(filePath, `call-2449-double-${index}`);
				await handleToolCall(
					toolCallDeps({ event, cwd: env.tmpDir, runtime, cacheManager }),
				);
				fs.writeFileSync(filePath, body);
				await handleToolResult(
					toolResultDeps({ event, runtime, cacheManager }),
				);
			}

			// One physical edit, one receipt. Not one per bookkeeping path that
			// happened to be reachable.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual([
				"agent-tool:patch_file",
				"agent-tool:patch_file",
				"agent-tool:patch_file",
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2449 review round 3 — the async settle never reorders registration", () => {
	it("keeps two same-path tool_results with different content as distinct pipelines", async () => {
		// T4. The settle stopped being synchronous (no sync filesystem work on
		// the tool_result path), so `handleToolResult` now YIELDS on a call that
		// has an armed observation. Everything the classified chain derives from
		// the file's post-result bytes therefore has to be read BEFORE that
		// yield: a racing tool_result for the same path rewrites the file while
		// the first call is awaiting, and the first call then registers under the
		// SECOND call's state hash — collapsing two distinct pipeline runs into
		// one (#1086's composite key, and the dedupe that rides on it).
		const env = setupTestEnvironment("pi-lens-2449-settle-order-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const previousDebounce = process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// Route through inFlightPipelines rather than the debounce coalescer.
		delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
		try {
			const filePath = path.join(env.tmpDir, "race.ts");
			fs.writeFileSync(filePath, "export const z = 1;\n");
			// The armed observation watches an UNRELATED path that never moves,
			// so the settle finds nothing, replays nothing, and the classified
			// chain below still runs — which is what puts the ordering under
			// test rather than the skip.
			const watched = path.join(env.tmpDir, "watched.ts");
			fs.writeFileSync(watched, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();

			await armObservedMutation({
				toolCallId: "call-race-a",
				toolName: "edit",
				targetPath: watched,
				cwd: env.tmpDir,
				sessionGeneration: runtime.sessionGeneration,
				turnIndex: runtime.turnIndex,
			});

			const editEvent = (toolCallId: string): Record<string, unknown> => ({
				toolName: "edit",
				toolCallId,
				input: { path: filePath },
				content: [{ type: "text", text: "edited" }],
			});

			const first = handleToolResult(
				toolResultDeps({
					event: editEvent("call-race-a"),
					runtime,
					cacheManager,
				}),
			);
			// Synchronously, before the first call can resume from its settle.
			fs.writeFileSync(filePath, "export const z = 2;\n");
			const second = handleToolResult(
				toolResultDeps({
					event: editEvent("call-race-b"),
					runtime,
					cacheManager,
				}),
			);
			await Promise.all([first, second]);

			// Two distinct post-result states, two pipeline runs.
			expect(vi.mocked(runPipeline)).toHaveBeenCalledTimes(2);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			if (previousDebounce === undefined)
				delete process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS;
			else process.env.PI_LENS_TOOL_RESULT_DEBOUNCE_MS = previousDebounce;
			env.cleanup();
		}
	});
});

describe("#2430 — the net does not arm for a classified tool", () => {
	it("takes no snapshot for a plain `write`, so the hot path is unchanged", async () => {
		const env = setupTestEnvironment("pi-lens-2430-hotpath-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "written.ts");
			fs.writeFileSync(filePath, SOURCE);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			const statSpy = vi.spyOn(fs.promises, "stat");
			await handleToolCall(
				toolCallDeps({
					event: {
						toolName: "write",
						toolCallId: "call-2430-write",
						input: { path: filePath, content: SOURCE },
					},
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			const observedStats = statSpy.mock.calls.length;
			statSpy.mockRestore();

			// The seam classifies `write`, so `armObservedMutation` is never
			// reached and the snapshot's stat storm never happens. Anything above
			// a handful here means the net armed for a classified tool.
			expect(observedStats).toBeLessThan(4);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 item 3 — the settled sweep is wired ahead of the deferred drain", () => {
	it("runs the sweep before the drain and re-baselines after it", () => {
		// A source-level wiring assertion, for the same reason
		// `tests/index-loop-block-wiring.test.ts` uses one: `agent_settled` is a
		// host event this suite cannot fire, and the ORDER is the contract —
		// a sweep after the drain would queue every drifted file one whole run
		// late.
		const indexSource = fs.readFileSync(
			path.join(import.meta.dirname, "..", "..", "index.ts"),
			"utf-8",
		);
		const sweepAt = indexSource.indexOf(
			"await runObservedSettledSweepSafely(ctx)",
		);
		const drainAt = indexSource.indexOf("await runDeferredMutationDrain(ctx)");
		const refreshAt = indexSource.indexOf(
			"await refreshObservedLedgerSafely(ctx)",
		);
		expect(sweepAt).toBeGreaterThan(-1);
		expect(drainAt).toBeGreaterThan(sweepAt);
		expect(refreshAt).toBeGreaterThan(drainAt);
	});
});

describe("#2449 review round 4 — the observed-settle return skips only duplicates", () => {
	it("keeps the applied-edit records, mutation receipt and cachedExports refresh", async () => {
		// S4. Round 3 (S2) added an early return so a provisionally-learned tool
		// did not record the same physical edit twice. It was labelled "skipped turn
		// tracking" and skipped considerably more than that. Three of the steps
		// below it have NO counterpart in `recordMutationThroughSeam`, so nothing
		// else ran them:
		//
		//   - the #2402 applied-edit records, so an identical retry escalated
		//     through the oldText-not-found ladder instead of being recognized;
		//   - `recordMutationToolReceipt`, the write→edit ordering state;
		//   - the `cachedExports` refresh, so the pre-write STOP check kept firing
		//     on names the edit had just removed.
		const env = setupTestEnvironment("pi-lens-2449-narrow-skip-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "narrowed.ts");
			const withStale = `export const staleName = 1;\n${SOURCE}`;
			fs.writeFileSync(filePath, withStale);
			const { runtime, cacheManager } = newSession(env.tmpDir);

			// Non-vacuity: neither the NAME tier nor the SHAPE tier can classify
			// this call, so the observational net is the only thing that reaches the
			// bookkeeping chain — which is what makes the skip path reachable at all.
			const firstEvent = retryEvent(filePath, "call-2449-narrow-0");
			expect(
				classifyMutatingTool(firstEvent as never, {
					filePath,
					recognizeOnly: true,
				}),
			).toBeUndefined();

			// Call 1 arms, observes and attributes the tool.
			await handleToolCall(
				toolCallDeps({
					event: firstEvent,
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			fs.writeFileSync(filePath, `${withStale}const d = 4;\n`);
			await handleToolResult(
				toolResultDeps({ event: firstEvent, runtime, cacheManager }),
			);

			// Call 2 is classified BY NAME from the attribution and is still armed,
			// so its tool_result takes the early return under test.
			runtime.cachedExports.set("staleName", filePath);
			const receiptSpy = vi.spyOn(runtime, "recordMutationToolReceipt");
			const appliedSpy = vi.spyOn(runtime.partialApplyRecords, "record");

			const secondEvent = retryEvent(filePath, "call-2449-narrow-1");
			await handleToolCall(
				toolCallDeps({
					event: secondEvent,
					cwd: env.tmpDir,
					runtime,
					cacheManager,
				}),
			);
			// The edit removes the exported name cachedExports is holding.
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\nconst e = 5;\n`);
			await handleToolResult(
				toolResultDeps({ event: secondEvent, runtime, cacheManager }),
			);

			// The skip really happened: one change-log receipt per physical edit,
			// which is the round-3 property the early return exists for.
			expect(
				readChangesSince(env.tmpDir, 0).map((change) => change.source),
			).toEqual(["agent-tool:patch_retry", "agent-tool:patch_retry"]);

			// And the three non-duplicated steps ran anyway.
			expect(receiptSpy).toHaveBeenCalledWith(filePath, "edit");
			expect(appliedSpy).toHaveBeenCalled();
			expect(runtime.cachedExports.has("staleName")).toBe(false);

			receiptSpy.mockRestore();
			appliedSpy.mockRestore();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});
