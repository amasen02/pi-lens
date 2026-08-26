/**
 * Turn-end collect-later delivery for slow auxiliary LSP servers
 * (#2001/#2002).
 *
 * Drives the real `handleTurnEnd` against a mocked `getLSPService()` seam
 * (the process boundary — a real auxiliary client is an external child
 * process) and asserts the agent-visible guarantees:
 *   1. Findings an auxiliary published AFTER its aux-grace window expired are
 *      probed from the client cache at the next turn end and DELIVERED as an
 *      advisory (`runtime-turn:late-auxiliary-findings`, gated surface).
 *   2. A cited file edited after the mark timestamp drops its findings; a
 *      deleted cited file drops too. Neither is delivered stale, and both are
 *      counted in the `late_auxiliary_findings` latency record.
 *   3. A pair whose client is alive but still empty re-arms — freshness
 *      baseline preserved, TTL anchored on the last re-arm so each probe
 *      extends the window (`PI_LENS_LATE_AUX_REARM_TTL_MS`-tunable); past
 *      the TTL or with a dead client the pair drops.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/lsp/index.js", () => ({
	// Only `getLSPService` crosses this seam in handleTurnEnd's import graph.
	getLSPService: () => ({ readCachedDiagnosticsForServers }),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../../clients/runtime-turn.js";
import {
	drainPendingAuxiliaryCoverage,
	markPendingAuxiliaryCoverage,
	MAX_LATE_AUX_REARMS,
	pendingAuxiliaryCoverageSizeForTests,
	readLateAuxRearmTtlMs,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { setupTestEnvironment } from "../test-utils.js";

function diag(line: number, message: string): LSPDiagnostic {
	return {
		range: {
			start: { line, character: 0 },
			end: { line, character: 10 },
		},
		severity: 2,
		code: "rule-x",
		source: "opengrep",
		message,
	};
}

function makeDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

/** Register the file as modified this turn so turn_end runs its main path. */
function registerEdit(
	env: { tmpDir: string },
	sessionId: string,
	cacheManager: CacheManager,
	filePath: string,
	content = "export const value = 1;\n",
): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	// Pin mtime 10s in the past so the freshness relation is explicit.
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(filePath, past, past);
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		sessionId,
	);
}

function turnEndContent(cacheManager: CacheManager, cwd: string): string {
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", cwd)?.data
			?.content ?? ""
	);
}

function lateAuxRecord(): any | undefined {
	return logLatency.mock.calls
		.map((call) => call[0])
		.find(
			(entry: any) =>
				entry?.type === "phase" && entry?.phase === "late_auxiliary_findings",
		);
}

beforeEach(() => {
	readCachedDiagnosticsForServers.mockReset();
	logLatency.mockClear();
	resetPendingAuxiliaryCoverage();
});

afterEach(() => {
	resetPendingAuxiliaryCoverage();
	delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
});

describe("turn-end late-auxiliary findings (#2001/#2002)", () => {
	it("delivers findings an auxiliary published after its grace window expired", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-deliver-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			registerEdit(env, "late-aux-session", cacheManager, file);

			// The grace expired without publication → the pair was marked ~2s
			// AFTER the file write but BEFORE the scan finished.
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
			// By turn end the scanner has published into its client cache.
			readCachedDiagnosticsForServers.mockImplementation(
				async (_filePath: string, serverIds: ReadonlySet<string>) => {
					const out = new Map<
						string,
						{ diags: LSPDiagnostic[]; publishedAt: number }
					>();
					if (serverIds.has("opengrep"))
						out.set("opengrep", {
							diags: [diag(4, "late finding body")],
							publishedAt: Date.now(),
						});
					return out;
				},
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("Late auxiliary diagnostics");
			expect(content).toContain("opengrep");
			expect(content).toContain("late finding body");
			expect(content).toContain(path.basename(file));

			// The pair was consumed, not left pending.
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);

			// One bounded latency record names the outcome counts.
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata).toMatchObject({
				pending: 1,
				delivered: 1,
				stale: 0,
				rearmed: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops findings when the cited file was edited after the mark", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-stale-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-stale" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "stale.ts");
			registerEdit(env, "late-aux-stale", cacheManager, file);

			// Marked long before the edit that drifted the file past the mark:
			// mtime (now-10s) > mark (now-60s) + tolerance → stale → drop.
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 60_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "should not appear")],
								publishedAt: Date.now(),
							},
						],
					]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("should not appear");
			expect(content).not.toContain("Late auxiliary diagnostics");

			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata).toMatchObject({ pending: 1, delivered: 0 });
			expect(record.metadata.stale).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("retires a newer empty publication as cleanConfirmed", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-clean-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-clean" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "clean.ts");
			registerEdit(env, "late-aux-clean", cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2_000);
			const clean: {
				diags: LSPDiagnostic[];
				publishedAt: number;
			} = { diags: [], publishedAt: Date.now() };
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([["opengrep", clean]]),
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				pending: 1,
				cleanConfirmed: 1,
				rearmed: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("retires a never-published pair at the re-arm ceiling", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-ceiling-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-ceiling" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "ceiling.ts");
			registerEdit(env, "late-aux-ceiling", cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([["opengrep", { diags: [], publishedAt: undefined }]]),
			);

			for (let turn = 0; turn <= MAX_LATE_AUX_REARMS; turn += 1) {
				registerEdit(env, "late-aux-ceiling", cacheManager, file);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}

			const ceilingRemaining = drainPendingAuxiliaryCoverage();
			expect(ceilingRemaining).toHaveLength(0);
			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			expect(records.at(-1)?.metadata).toMatchObject({
				pairCreated: 1,
				ceilingExhausted: 1,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("retires a stale-looping pair at the re-arm ceiling with a distinct outcome (#2167)", async () => {
		// The no-publication ceiling above bounds the "still scanning" branch.
		// A pair that DOES get answered every turn, but whose findings are
		// always stale (the cited file keeps looking edited-after-the-scan),
		// re-arms through the SEPARATE clause at the stale-findings site. That
		// clause carries its own `(pair.rearmCount ?? 0) < MAX_LATE_AUX_REARMS`
		// check; deleting it would let this loop re-arm forever instead of
		// ever reaching `ceilingExhausted`.
		const env = setupTestEnvironment("pi-lens-late-aux-stale-ceiling-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-stale-ceiling" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const sessionId = "late-aux-stale-ceiling";
			const file = path.join(env.tmpDir, "src", "stale-ceiling.ts");

			// Write the file ONCE and pin its mtime far in the future so every
			// turn's freshness gate sees it as edited-after-the-scan (stale),
			// independent of how many times the pair's baseline gets refreshed
			// by the stale-path re-arm (which stamps a fresh `markedAtMs`).
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "export const value = 1;\n");
			const future = new Date(Date.now() + 600_000);
			fs.utimesSync(file, future, future);
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				sessionId,
			);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			const farPublishedAt = Date.now() + 500_000;
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "stale finding body")],
								publishedAt: farPublishedAt,
							},
						],
					]),
			);

			for (let turn = 0; turn <= MAX_LATE_AUX_REARMS; turn += 1) {
				// Keep this turn's modified-file worklist non-empty WITHOUT
				// touching the pinned future mtime the freshness gate reads.
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					sessionId,
				);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}

			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("stale finding body");

			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			const rearmedTotal = records.reduce(
				(sum: number, r: any) => sum + (r.metadata.rearmed ?? 0),
				0,
			);
			expect(rearmedTotal).toBe(MAX_LATE_AUX_REARMS);
			// The ceiling turn retires the pair as `ceilingExhausted` — a
			// DISTINCT outcome from `expired` (TTL) or `answered` (delivered).
			expect(records.at(-1)?.metadata).toMatchObject({
				pairCreated: 1,
				ceilingExhausted: 1,
				expired: 0,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("bounds a transient probe throw to a re-arm instead of dropping coverage (#2167 R2-2)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-probe-throw-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-probe-throw" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const sessionId = "late-aux-probe-throw";
			const file = path.join(env.tmpDir, "src", "probe-throw.ts");
			registerEdit(env, sessionId, cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			readCachedDiagnosticsForServers.mockRejectedValue(
				new Error("transient cache read failure"),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// One transient throw counts the failure AND keeps the pair
			// pending — the coverage must not vanish uncounted.
			expect(pendingAuxiliaryCoverageSizeForTests()).toBe(1);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				probeFailed: 1,
				rearmed: 1,
				pendingAfter: 1,
			});

			// The re-arm is still bounded: repeated throws eventually retire
			// the pair instead of looping forever.
			for (let turn = 0; turn < MAX_LATE_AUX_REARMS; turn += 1) {
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					sessionId,
				);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}
			expect(pendingAuxiliaryCoverageSizeForTests()).toBe(0);
			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			expect(records.at(-1)?.metadata).toMatchObject({
				ceilingExhausted: 1,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("reconciles pair units across clean, stale, absent, and eviction paths", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-pair-reconcile-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-pair-reconcile" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const clean = path.join(env.tmpDir, "src", "clean.ts");
			const stale = path.join(env.tmpDir, "src", "stale.ts");
			registerEdit(env, "late-aux-pair-reconcile", cacheManager, stale);
			registerEdit(env, "late-aux-pair-reconcile", cacheManager, clean);
			markPendingAuxiliaryCoverage(
				path.join(env.tmpDir, "src", "evicted.ts"),
				["opengrep"],
				Date.now() - 1000,
			);
			markPendingAuxiliaryCoverage(clean, ["opengrep"], Date.now() - 1000);
			markPendingAuxiliaryCoverage(
				stale,
				["opengrep"],
				Date.now() - 60_000,
				Date.now() - 1000,
			);
			const absent = path.join(env.tmpDir, "src", "absent.ts");
			markPendingAuxiliaryCoverage(absent, ["opengrep"], Date.now() - 1000);
			const expired = path.join(env.tmpDir, "src", "expired.ts");
			markPendingAuxiliaryCoverage(expired, ["opengrep"], Date.now() - 10_000);
			for (let index = 0; index < 47; index += 1) {
				markPendingAuxiliaryCoverage(
					path.join(env.tmpDir, "src", `clean-${index}.ts`),
					["opengrep"],
					Date.now() - 1000,
				);
			}
			readCachedDiagnosticsForServers.mockImplementation(
				async (filePath: string) => {
					if (filePath === absent) return new Map();
					if (filePath === stale)
						return new Map([
							[
								"opengrep",
								{ diags: [diag(0, "old")], publishedAt: Date.now() },
							],
						]);
					if (filePath === expired)
						return new Map([
							["opengrep", { diags: [], publishedAt: Date.now() - 20_000 }],
						]);
					return new Map([
						["opengrep", { diags: [], publishedAt: Date.now() }],
					]);
				},
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const metadata = lateAuxRecord()?.metadata;
			// 52 pairs were marked above (evicted.ts, clean, stale, absent,
			// expired, clean-0..46) against a 50-pair cap: "evicted.ts" and
			// "clean" are the two OLDEST pairs, so both are cap-evicted before
			// this drain ever sees them (#2168). `capEvicted` folds them back
			// into the reconciliation sum instead of letting them vanish
			// uncounted — `pairCreated` (52) now reflects every pair actually
			// marked, not just what survived to be drained (50).
			expect(metadata).toMatchObject({
				pairCreated: 52,
				capEvicted: 2,
				cleanConfirmed: 47,
				clientGone: 1,
				expired: 1,
				rearmed: 1,
				pendingAfter: 1,
			});
			expect(
				metadata.cleanConfirmed +
					metadata.clientGone +
					metadata.expired +
					metadata.pendingAfter +
					metadata.capEvicted,
			).toBe(metadata.pairCreated);
			expect(metadata.stale).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("reconciles expired and conversion-empty retirements", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-reconcile-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-reconcile" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const expired = path.join(env.tmpDir, "src", "expired.ts");
			const empty = path.join(env.tmpDir, "src", "empty.ts");
			registerEdit(env, "late-aux-reconcile", cacheManager, expired);
			registerEdit(env, "late-aux-reconcile", cacheManager, empty);
			markPendingAuxiliaryCoverage(expired, ["opengrep"], Date.now() - 10_000);
			markPendingAuxiliaryCoverage(empty, ["opengrep"], Date.now() - 2_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async (filePath: string) =>
					filePath === expired
						? new Map([
								["opengrep", { diags: [], publishedAt: Date.now() - 20_000 }],
							])
						: new Map([
								[
									"opengrep",
									{ diags: [{ message: "bad" }], publishedAt: Date.now() },
								],
							]),
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			const metadata = lateAuxRecord()?.metadata;
			expect(metadata).toMatchObject({ pending: 2, expired: 1, missing: 1 });
			expect(metadata.expired + metadata.missing).toBe(metadata.pending);
		} finally {
			env.cleanup();
		}
	});

	it("drops findings when the cited file is gone", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-deleted-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-deleted" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const kept = path.join(env.tmpDir, "src", "kept.ts");
			registerEdit(env, "late-aux-deleted", cacheManager, kept);

			const deleted = path.join(env.tmpDir, "src", "deleted.ts");
			markPendingAuxiliaryCoverage(deleted, ["opengrep"], Date.now() - 2000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "finding for deleted file")],
								publishedAt: Date.now(),
							},
						],
					]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("finding for deleted file");
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata.missing).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("re-arms an alive-but-empty probe within the TTL and preserves the baseline", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-rearm-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-rearm" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "slow.ts");
			registerEdit(env, "late-aux-rearm", cacheManager, file);

			const markedAt = Date.now() - 1000;
			markPendingAuxiliaryCoverage(file, ["opengrep"], markedAt);
			// Client alive (present in the map) but the scan has not landed yet.
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// Nothing delivered, but the pair survives for the NEXT turn end.
			expect(turnEndContent(cacheManager, env.tmpDir)).not.toContain(
				"Late auxiliary diagnostics",
			);
			const stillPending = drainPendingAuxiliaryCoverage();
			expect(stillPending).toHaveLength(1);
			// The freshness baseline survives re-arm untouched...
			expect(stillPending[0].markedAtMs).toBe(markedAt);
			// ...and the successful probe advanced the TTL anchor past the mark.
			expect(stillPending[0].lastRearmedAtMs).toBeGreaterThan(markedAt);

			// Past the TTL the same empty probe retires the pair instead. The
			// store preserves a live pair's baseline, so expire by draining first
			// and marking fresh with an already-aged timestamp.
			resetPendingAuxiliaryCoverage();
			registerEdit(env, "late-aux-rearm", cacheManager, file);
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - readLateAuxRearmTtlMs() - 5000,
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("a successful probe extends the window past the original mark's TTL", async () => {
		// Red-first core of the decoupled-clock fix: a pair whose MARK is older
		// than the TTL but that was just re-armed by a successful empty probe
		// must stay pending — each probe proves the scanner is alive but slow.
		const env = setupTestEnvironment("pi-lens-late-aux-extend-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-extend" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "extend.ts");
			registerEdit(env, "late-aux-extend", cacheManager, file);

			// Marked 10s ago (past the 5s TTL from mark) but re-armed 1s ago by
			// the previous turn's probe.
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - 10_000,
				Date.now() - 1_000,
			);
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// Kept for the next turn end; baseline unchanged, anchor advanced.
			const stillPending = drainPendingAuxiliaryCoverage();
			expect(stillPending).toHaveLength(1);
			expect(stillPending[0].markedAtMs).toBeLessThan(Date.now() - 5_000);
			expect(stillPending[0].lastRearmedAtMs).toBeGreaterThan(
				Date.now() - 5_000,
			);
		} finally {
			env.cleanup();
		}
	});

	it("an un-re-armed pair past the TTL still drops (no always-keep drift)", async () => {
		// Mirror guard for the extension test: without a re-arm stamp the TTL
		// must keep measuring from the mark, so an old silent pair is retired.
		const env = setupTestEnvironment("pi-lens-late-aux-expire-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-expire" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "expire.ts");
			registerEdit(env, "late-aux-expire", cacheManager, file);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 10_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("drops a pair silently when the auxiliary client is gone", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-gone-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-gone" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "gone.ts");
			registerEdit(env, "late-aux-gone", cacheManager, file);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
			// The service answers with an EMPTY map: no live client for opengrep.
			readCachedDiagnosticsForServers.mockImplementation(async () => new Map());

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata.clientGone).toBe(1);
			expect(record.metadata.rearmed).toBe(0);
		} finally {
			env.cleanup();
		}
	});
});
