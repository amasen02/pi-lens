/**
 * Turn-end integration for the widget-footer dependency-drift delivery cap
 * (#2275), sibling of #1950's inline-blocker cap
 * (`blocker-freshness-delivery-cap.test.ts`).
 *
 * #1631's dependency-drift gate demotes a blocking widget-store diagnostic
 * whose forward import changed out-of-band
 * (`reconcileStaleWidgetDependencyBlockers` / the #1790 turn-end sweep chain
 * via `markWidgetFileBlockersStale`) to a `[stale — re-run to confirm]`
 * advisory (demote, not drop — #1419). Unlike #1950's inline-blocker
 * demotion, that widget demotion never retired: it re-derives every turn
 * from the widget's own diagnostic list with no stored delivery count, so it
 * re-serves in the footer for the rest of the session.
 *
 * This drives the real `handleTurnEnd` across several turns over a
 * WIDGET-ONLY blocking row (recorded straight into `widget-state.ts` via
 * `recordDiagnostics`, never through `runtime.recordInlineBlockers` — the
 * #1790 cache-served-replay shape the issue's "completely separate path"
 * describes) and asserts:
 *   1. The demotion re-serves, unretired, below the delivery cap — the
 *      demote-not-drop invariant (#1419) holds: the entry is still visible
 *      as a stale advisory right up to the cap.
 *   2. At the cap (`DEPENDENCY_DRIFT_MAX_DELIVERIES`, shared with #1950), the
 *      diagnostic is retired (dropped from the widget store) and the
 *      degradation ledger records it with the SAME "capped, re-run can still
 *      confirm" reason #1950 uses, under the same `demoted-finding-retired`
 *      kind — the same bounded telemetry/ledger record shape.
 *   3. After retirement, the diagnostic is gone from the widget store and
 *      never resurfaces.
 *
 * Mutation proof: deleting the `isDependencyDriftDeliveryCapReached` check in
 * `runtime-turn.ts`'s widget-cap loop (or hardcoding it to `false`) makes the
 * cap-turn assertions below fail — the diagnostic would still be present and
 * no `demoted-finding-retired` ledger entry would exist.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { DEPENDENCY_DRIFT_MAX_DELIVERIES } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	isBlocking,
	recordDiagnostics,
} from "../../clients/widget-state.js";
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

function makeTurnEndDeps(
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
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

/**
 * Drive one more turn with activity so `handleTurnEnd` doesn't early-return
 * on "no modified files this turn". Touches a per-turn noise file alongside
 * `consumer` — mirrors `blocker-freshness-delivery-cap.test.ts`'s own
 * `driveTurn`, kept even though the widget-cap loop has no signature-dedupe
 * to defer against (it isn't part of the agent-facing advisory text), so
 * this test's turn-driving shape stays identical to its sibling's.
 */
function driveTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	consumer: string,
	cwd: string,
	sessionId: string,
	turn: number,
): Promise<void> {
	runtime.beginTurn();
	runtime.bumpFileSeq(consumer);
	cacheManager.addModifiedRange(
		consumer,
		{ start: 1, end: 2 },
		false,
		cwd,
		sessionId,
	);
	const noise = path.join(cwd, `noise-${turn}.ts`);
	fs.writeFileSync(noise, `export const noise${turn} = ${turn};\n`);
	runtime.bumpFileSeq(noise);
	cacheManager.addModifiedRange(
		noise,
		{ start: 1, end: 1 },
		false,
		cwd,
		sessionId,
	);
	return handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	clearWidgetState();
	logLatency.mockClear();
});

describe("widget-footer dependency-drift delivery cap (#2275)", () => {
	it(`retires a widget-only demoted diagnostic after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries, with #1950's "still confirmable" ledger reason`, async () => {
		const env = setupTestEnvironment("pi-lens-2275-cap-");
		try {
			const sessionId = "widget-cap-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);

			// Widget-ONLY blocking row — recorded straight into the widget store,
			// never through `runtime.recordInlineBlockers`. This is the #1790
			// cache-served-replay shape: a row the sweep's inline-blocker
			// population never sees, reached only via `getWidgetBlockingFilesForSweep`.
			recordDiagnostics(
				consumer,
				[
					{
						severity: "error",
						semantic: "blocking",
						message: "type error demoted by drift",
						tool: "lsp",
					},
				],
				1,
				Date.now() - 60_000,
			);
			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);

			// The dependency drifts out-of-band after the verdict.
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			// Turn 1: the #1790 sweep chain detects drift and demotes via
			// `markWidgetFileBlockersStale`; the SAME turn's new #2275 delivery
			// loop counts it as delivery 1 of the cap.
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			let stored = getFileDiagnostics(consumer) ?? [];
			expect(stored).toHaveLength(1);
			// Demote-not-drop (#1419): still served, as a stale advisory, not an
			// authoritative blocker, right up to the cap.
			expect(stored[0]?.stale).toBe(true);
			expect(stored[0]?.staleReason).toBe("dependency-drift");
			expect(isBlocking(stored[0]!)).toBe(false);
			expect(stored[0]?.staleDeliveryCount).toBe(1);

			// Turns 2..cap-1: re-served, still not retired, count advancing by
			// exactly one per delivered turn.
			for (
				let delivery = 2;
				delivery < DEPENDENCY_DRIFT_MAX_DELIVERIES;
				delivery++
			) {
				await driveTurn(
					runtime,
					cacheManager,
					consumer,
					env.tmpDir,
					sessionId,
					delivery,
				);
				stored = getFileDiagnostics(consumer) ?? [];
				expect(stored).toHaveLength(1);
				expect(stored[0]?.stale).toBe(true);
				expect(stored[0]?.staleDeliveryCount).toBe(delivery);
			}

			// The delivery that reaches the cap retires the diagnostic.
			await driveTurn(
				runtime,
				cacheManager,
				consumer,
				env.tmpDir,
				sessionId,
				DEPENDENCY_DRIFT_MAX_DELIVERIES,
			);
			stored = getFileDiagnostics(consumer) ?? [];
			expect(stored).toHaveLength(0);

			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "demoted-finding-retired",
						latestReasons: expect.arrayContaining([
							expect.objectContaining({
								reason: expect.stringContaining("re-run can still confirm"),
							}),
						]),
					}),
				]),
			);

			// A further turn has nothing left to re-serve: the diagnostic never
			// resurfaces once retired.
			await driveTurn(
				runtime,
				cacheManager,
				consumer,
				env.tmpDir,
				sessionId,
				DEPENDENCY_DRIFT_MAX_DELIVERIES + 1,
			);
			expect(getFileDiagnostics(consumer) ?? []).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
