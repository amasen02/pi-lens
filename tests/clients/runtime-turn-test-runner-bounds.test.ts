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
import { peekTestFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	TEST_RUNNER_BATCH_BUDGET_MS,
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
/**
 * Sources whose conventional test companion does NOT exist on disk.
 *
 * They are the FIRST sources in the worklist, deliberately (#2504 review
 * round 2, F4). Placed last — past `TEST_RUNNER_MAX_TARGETS` — the existsSync
 * guard was untestable: deleting it left those sources to be dropped by the
 * target-count cap instead, so `ran` still held no missing file and the
 * assertion below stayed green over the deleted guard. Ahead of the cap
 * boundary, deleting the guard puts them straight into the fired batch.
 */
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
			// The FIRST N sources deliberately have NO test file on disk — see
			// MISSING_TEST_COMPANIONS. Everything after them does, so the
			// target-count cap is still reached and still exercised.
			if (i >= MISSING_TEST_COMPANIONS) {
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
		// Named, so a failure says WHICH guard broke rather than only that some
		// nonexistent file was spawned for. These three sit ahead of the
		// target-count cap, so only the existsSync guard can keep them out.
		for (let i = 0; i < MISSING_TEST_COMPANIONS; i++) {
			expect(ran.some((f) => f.endsWith(`f${i}.test.ts`))).toBe(false);
		}
		// The cap is genuinely reached even after the missing companions are
		// dropped, so this case still covers both bounds at once.
		expect(ran.length).toBe(TEST_RUNNER_MAX_TARGETS);
	});
});

/**
 * #2522: the real turn-end candidate loop (`runtime-turn.ts`) must never
 * fire a resolved target under the built-in integration/e2e exclusion list,
 * regardless of which strategy (failed-first/related/self) resolved it —
 * reproduced through the real `handleTurnEnd` selection loop, not a
 * hand-fed input shaped to hit the guard.
 */
describe("#2522 AC1 — turn_end selection excludes integration/e2e targets", () => {
	it("never spawns a target resolved under tests/integration/, and dbg names the excluded target", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		fs.mkdirSync(path.join(env.tmpDir, "tests", "integration"), {
			recursive: true,
		});
		const source = path.join(env.tmpDir, "src", "delegate.ts");
		fs.writeFileSync(source, "export const delegate = 1;\n");
		const integrationTest = path.join(
			env.tmpDir,
			"tests",
			"integration",
			"opencode-delegate.test.ts",
		);
		fs.writeFileSync(integrationTest, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		const ran: string[] = [];
		const dbgLines: string[] = [];
		const testRunnerClient = {
			// Mirrors the reported turn: whichever strategy resolved it, the
			// candidate's OWN test file lands under tests/integration/.
			getTestRunTarget: () => ({
				testFile: integrationTest,
				runner: "vitest",
				config: undefined,
				strategy: "related",
			}),
			runTestFileAsync: async (testFile: string) => {
				ran.push(testFile);
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
			dbg: (msg: string) => dbgLines.push(msg),
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

		// The fan-out is fire-and-forget; give it a beat, then assert nothing
		// was ever dispatched (there's only one candidate, and it's excluded).
		await delay(200);

		expect(ran).toHaveLength(0);
		expect(
			dbgLines.some((l) => l.includes("excluded") && l.includes("integration")),
		).toBe(true);
	});
});

/**
 * #2522 AC3: through the REAL `handleTurnEnd` delivery path (not a
 * hand-written cache record), a batch made entirely of RUNNER errors must be
 * persisted and delivered as advisory; a batch containing a genuine failing
 * test must keep the "fix before continuing" framing, unchanged.
 */
describe("#2522 AC3 — delivery framing distinguishes runner errors from real failures", () => {
	it("persists runnerErrorOnly:true and delivers advisory framing for an all-runner-error batch", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		const source = path.join(env.tmpDir, "src", "widget.ts");
		const testFile = path.join(env.tmpDir, "src", "widget.test.ts");
		fs.writeFileSync(source, "export const widget = 1;\n");
		fs.writeFileSync(testFile, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		let settled = false;
		const testRunnerClient = {
			getTestRunTarget: () => ({
				testFile,
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async () => {
				settled = true;
				// A runner error: the suite never started (missing provider/
				// binary), so `failed === 0` by construction — mirrors
				// `test-runner-client.ts`'s own `emptyResult` shape.
				return {
					file: testFile,
					sourceFile: source,
					runner: "vitest",
					passed: 0,
					failed: 0,
					error: "spawn opencode ENOENT",
				};
			},
			formatResult: (r: { error?: string }) =>
				`[Tests] ⚠ Could not run tests: ${r.error}`,
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

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !settled) await delay(20);
		// Give the fire-and-forget `.then()` a beat to land the cache write.
		await delay(100);

		const persisted = cacheManager.readCache<{
			content: string;
			runnerErrorOnly?: boolean;
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.content).toContain("Could not run tests");
		expect(persisted?.runnerErrorOnly).toBe(true);

		const message =
			peekTestFindings(cacheManager, env.tmpDir, runtime)?.messages[0]
				?.content ?? "";
		expect(message).toContain("advisory");
		expect(message).not.toContain("fix before continuing");
	});

	it("persists runnerErrorOnly:false and keeps the blocking framing for a genuine failure", async () => {
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);

		fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
		const source = path.join(env.tmpDir, "src", "widget.ts");
		const testFile = path.join(env.tmpDir, "src", "widget.test.ts");
		fs.writeFileSync(source, "export const widget = 1;\n");
		fs.writeFileSync(testFile, "export {};\n");
		cacheManager.addModifiedRange(
			source,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			runtime.telemetrySessionId,
		);

		let settled = false;
		const testRunnerClient = {
			getTestRunTarget: () => ({
				testFile,
				runner: "vitest",
				config: undefined,
				strategy: "self",
			}),
			runTestFileAsync: async () => {
				settled = true;
				return {
					file: testFile,
					sourceFile: source,
					runner: "vitest",
					passed: 0,
					failed: 1,
					failures: [{ name: "widget works", message: "expected 1 to be 2" }],
				};
			},
			formatResult: () => "[Tests] ✗ 1/1 failed",
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

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !settled) await delay(20);
		await delay(100);

		const persisted = cacheManager.readCache<{
			content: string;
			runnerErrorOnly?: boolean;
		}>("test-runner-findings", env.tmpDir)?.data;
		expect(persisted?.runnerErrorOnly).toBe(false);

		const message =
			peekTestFindings(cacheManager, env.tmpDir, runtime)?.messages[0]
				?.content ?? "";
		expect(message).toContain(
			"Test failures detected last turn — fix before continuing",
		);
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

/**
 * #2522 AC2: the batch-wide wall budget must sit well under the turn, and
 * distinct from (well below) the per-target 60s spawn timeout
 * (`test-runner-client.ts`'s `runTestFileAsync`) — reconciled to ONE
 * constant rather than adding a second budget alongside #2509's 90s.
 */
describe("#2522 AC2 — batch wall budget reconciled below the turn", () => {
	it("is well under a turn and well under the 60s per-target timeout", () => {
		expect(TEST_RUNNER_BATCH_BUDGET_MS).toBeLessThanOrEqual(20_000);
		expect(TEST_RUNNER_BATCH_BUDGET_MS).toBeLessThan(60_000);
	});
});
