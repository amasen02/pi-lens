/**
 * #2504 AC2 — the turn-end test-runner fan-out must be bounded.
 *
 * The reported turn fired 59 concurrent `vitest.cmd` spawns from a single
 * `Promise.allSettled(targets.map(runTestFileAsync))`: no concurrency cap, no
 * batch-wide wall budget, no target-count cap, and 9 of the targets pointed at
 * test files deleted from the repo long ago (each one spawned a runner only to
 * come back "Test file not found"). The event loop starved
 * (`cpuCoverageRatio 0.56`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	TEST_RUNNER_BATCH_CONCURRENCY,
	TEST_RUNNER_MAX_TARGETS,
	handleTurnEnd,
	runTestTargetsBounded,
} from "../../clients/runtime-turn.js";
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

const SOURCE_COUNT = 20;
/** Sources whose conventional test companion does NOT exist on disk. */
const MISSING_TEST_COMPANIONS = 3;

let env: { tmpDir: string; cleanup: () => void };

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-2504-runner-");
	resetDegradationLedger();
});

afterEach(() => {
	env.cleanup();
	resetDegradationLedger();
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("#2504 AC2 — bounded test-runner batch helper", () => {
	it("never exceeds the concurrency cap", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		await runTestTargetsBounded({
			targets: Array.from({ length: 24 }, (_, i) => `t${i}`),
			concurrency: 4,
			budgetMs: 60_000,
			run: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(5);
				inFlight -= 1;
				return "ok";
			},
		});
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	it("stops dispatching once the batch wall budget is spent", async () => {
		let started = 0;
		const outcome = await runTestTargetsBounded({
			targets: Array.from({ length: 40 }, (_, i) => `t${i}`),
			concurrency: 2,
			budgetMs: 40,
			run: async () => {
				started += 1;
				await delay(15);
				return "ok";
			},
		});
		expect(started).toBeLessThan(40);
		expect(outcome.skipped).toBeGreaterThan(0);
		expect(outcome.stopReason).toBe("budget");
	});

	it("stops dispatching when the ambient abort signal fires", async () => {
		const controller = new AbortController();
		let started = 0;
		const outcome = await runTestTargetsBounded({
			targets: Array.from({ length: 40 }, (_, i) => `t${i}`),
			concurrency: 2,
			budgetMs: 60_000,
			signal: controller.signal,
			run: async () => {
				started += 1;
				if (started === 4) controller.abort();
				await delay(5);
				return "ok";
			},
		});
		expect(started).toBeLessThan(40);
		expect(outcome.skipped).toBeGreaterThan(0);
		expect(outcome.stopReason).toBe("abort");
	});

	it("returns a settled result per dispatched target and survives a rejection", async () => {
		const outcome = await runTestTargetsBounded({
			targets: ["a", "b", "c"],
			concurrency: 2,
			budgetMs: 60_000,
			run: async (t: string) => {
				if (t === "b") throw new Error("boom");
				return t;
			},
		});
		expect(outcome.results).toHaveLength(3);
		expect(outcome.results.filter((r) => r.status === "rejected")).toHaveLength(
			1,
		);
		expect(outcome.skipped).toBe(0);
	});
});

describe("#2504 AC2 — turn_end wires the bounds into the real fan-out", () => {
	it("caps concurrency, caps the target count, and never spawns for a missing test file", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		for (let i = 0; i < SOURCE_COUNT; i++) {
			fs.writeFileSync(
				path.join(env.tmpDir, "src", `f${i}.ts`),
				`export const v${i} = ${i};\n`,
			);
			// The last N sources deliberately have NO test file on disk.
			if (i < SOURCE_COUNT - MISSING_TEST_COMPANIONS) {
				fs.writeFileSync(
					path.join(env.tmpDir, "src", `f${i}.test.ts`),
					"export {};\n",
				);
			}
			cacheManager.addModifiedRange(
				path.join(env.tmpDir, "src", `f${i}.ts`),
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				runtime.telemetrySessionId,
			);
		}

		let inFlight = 0;
		let maxInFlight = 0;
		let completed = 0;
		const ran: string[] = [];
		const testRunnerClient = {
			getTestRunTarget: (abs: string) => ({
				testFile: abs.replace(/\.ts$/, ".test.ts"),
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async (testFile: string) => {
				ran.push(testFile);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(15);
				inFlight -= 1;
				completed += 1;
				return {
					file: testFile,
					runner: "vitest",
					passed: 1,
					failed: 0,
					duration: 1,
				};
			},
			formatResult: () => "",
		};

		await handleTurnEnd({
			ctxCwd: env.tmpDir,
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
			testRunnerClient,
			resetLSPService: () => {},
			resetFormatService: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal turn_end deps
		} as any);

		// The fan-out is deliberately fire-and-forget; wait for it to settle.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && (completed === 0 || inFlight > 0)) {
			await delay(20);
		}

		// Literals, not the constants — this assertion has to go red on
		// pre-fix code for the BUG's reason (unbounded fan-out), not because a
		// not-yet-exported constant is `undefined`.
		expect(ran.length).toBeGreaterThan(0);
		expect(maxInFlight).toBeLessThanOrEqual(4);
		expect(ran.length).toBeLessThanOrEqual(12);
		expect(maxInFlight).toBeLessThanOrEqual(TEST_RUNNER_BATCH_CONCURRENCY);
		expect(ran.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_TARGETS);
		for (const testFile of ran) {
			expect(fs.existsSync(testFile)).toBe(true);
		}
	});
});

describe("#2504 AC2 — cap constants", () => {
	it("caps concurrency at 4", () => {
		expect(TEST_RUNNER_BATCH_CONCURRENCY).toBe(4);
	});

	it("caps the per-turn target count", () => {
		expect(TEST_RUNNER_MAX_TARGETS).toBeGreaterThan(0);
		expect(TEST_RUNNER_MAX_TARGETS).toBeLessThan(SOURCE_COUNT);
	});
});
