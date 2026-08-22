import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RUNNER_SKIP_REASONS,
	type RunnerGroup,
	type RunnerResult,
} from "../../../../clients/dispatch/types.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawn = vi.fn();
const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn(async (_toolId?: string) => "oxlint");
const logLatency = vi.hoisted(() => vi.fn());

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	resolveToolCommand: vi.fn(() => null),
	resolveToolCommandWithInstallFallback: vi.fn(async (_cwd: string) => {
		const installed = await ensureTool("oxlint");
		return installed ?? null;
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("oxlint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		logLatency.mockReset();
		ensureTool.mockResolvedValue("oxlint");
		// Simulate oxlint not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("keeps expected runner skip reasons on a closed type/runtime taxonomy", () => {
		expect(RUNNER_SKIP_REASONS).toEqual(["no-files-matched"]);
		const valid: RunnerResult = {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
			skipReason: "no-files-matched",
		};
		expect(valid.skipReason).toBe("no-files-matched");

		const invalid: RunnerResult = {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
			// @ts-expect-error free text is not an admitted telemetry reason
			skipReason: "ignored because someone felt like it",
		};
		expect(invalid.skipReason).toBe("ignored because someone felt like it");
	});

	it("does not skip test files (#576) — real correctness findings matter there too", async () => {
		const { default: oxlintRunner } =
			await import("../../../../clients/dispatch/runners/oxlint.js");
		expect(oxlintRunner.skipTestFiles).toBe(false);
	});

	it("auto-installs and runs oxlint as the no-config JS/TS fallback", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Unexpected console statement",
							code: "eslint(no-console)",
							severity: "warning",
							help: "Replace console.log with a logger",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			// hasTool returns false → triggers resolveToolCommandWithInstallFallback → ensureTool
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(ensureTool).toHaveBeenCalledWith("oxlint");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				expect.objectContaining({ timeout: 30000 }),
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
				fixSuggestion: "Replace console.log with a logger",
			});
		} finally {
			env.cleanup();
		}
	});

	it("reports exit-0 warning findings as succeeded, not failed (#1947, #1955 review F1)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-warning-exit-zero-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			// oxlint exits 0 whenever nothing reaches error severity, so a
			// warning-only report — its default severity — arrives at exit 0.
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Variable 'unused' is declared but never used",
							code: "eslint(no-unused-vars)",
							severity: "warning",
							help: "Consider removing this declaration",
							filename: filePath,
							labels: [{ span: { line: 1, column: 7 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			// status MUST be "succeeded", not "failed": plan.ts's
			// ["eslint", "oxlint", "biome-check-json"] fallback group
			// (dispatcher.ts runGroup) only stops at the first runner reporting
			// `status: "succeeded"`. A "failed" status here would let
			// biome-check-json run again on the same file for a mere warning —
			// extra spawns, a possible install, duplicate findings.
			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-unused-vars",
				severity: "warning",
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	it("a warning-only exit-0 run stops plan.ts's jsts fallback group at oxlint (#1955 review F1)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-fallback-stop-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Variable 'unused' is declared but never used",
							code: "eslint(no-unused-vars)",
							severity: "warning",
							filename: filePath,
							labels: [{ span: { line: 1, column: 7 } }],
						},
					],
				}),
				stderr: "",
			});

			const oxlintRunner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const { dispatchForFile, RunnerRegistry } =
				await import("../../../../clients/dispatch/dispatcher.js");

			// eslint has no config in this workspace, so the real eslint runner
			// would skip — stand in with the same status so the fallback chain
			// reaches oxlint exactly as plan.ts's
			// ["eslint", "oxlint", "biome-check-json"] group would.
			const biomeCalls: number[] = [];
			const registry = new RunnerRegistry();
			registry.register({
				id: "eslint",
				appliesTo: ["jsts"],
				priority: 1,
				enabledByDefault: true,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registry.register({ ...oxlintRunner, priority: 2 });
			registry.register({
				id: "biome-check-json",
				appliesTo: ["jsts"],
				priority: 3,
				enabledByDefault: true,
				async run() {
					biomeCalls.push(Date.now());
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const groups: RunnerGroup[] = [
				{
					mode: "fallback",
					runnerIds: ["eslint", "oxlint", "biome-check-json"],
				},
			];
			const ctx = {
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			};

			const result = await dispatchForFile(ctx as never, groups, registry);

			// The regression this pins: a "failed" status on oxlint's warning-only
			// exit-0 result would NOT stop a fallback group (dispatcher.ts's
			// runGroup only stops at "succeeded"), so biome-check-json would run
			// too — extra spawns, a possible install, duplicate findings.
			expect(biomeCalls).toHaveLength(0);
			expect(result.warnings.some((w) => w.tool === "oxlint")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("skips when ESLint is explicitly configured", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-eslint-config-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");
			fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(ensureTool).not.toHaveBeenCalled();
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to plain oxlint when Vite+ is configured but vp is not installed", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-vite-plus-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
			);

			// First call: vp --version (not found)
			// Second call: oxlint --format unix <file> (success, no issues)
			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"vp",
				["--version"],
				expect.objectContaining({ timeout: 5000 }),
			);
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				expect.objectContaining({ timeout: 30000 }),
			);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	it("promotes severity=error diagnostics to blocking semantic", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-error-promotion-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "debugger;\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "`debugger` statement is not allowed",
							code: "eslint(no-debugger)",
							severity: "error",
							help: "Remove the debugger statement",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]).toMatchObject({
				severity: "error",
				semantic: "blocking",
				rule: "no-debugger",
				fixSuggestion: "Remove the debugger statement",
			});
		} finally {
			env.cleanup();
		}
	});

	it("falls back to unix-format parsing when oxlint emits non-JSON output", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: `${filePath}:1:1: Unexpected console statement (no-console)\n`,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
			});
			// Unix fallback has no fix info — fixSuggestion is absent here.
			expect(result.diagnostics[0].fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps a matched clean file distinct from a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-clean-match-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({ diagnostics: [], number_of_files: 1 }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const log = vi.fn();
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
				log,
			} as never);

			expect(result).toMatchObject({
				status: "succeeded",
				semantic: "none",
				diagnostics: [],
			});
			expect(result.skipReason).toBeUndefined();
			expect(log).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps nonzero garbage as a failure, not a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-garbage-failure-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "oxlint: internal failure, report unavailable\n",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]).toMatchObject({
				semantic: "warning",
				message: expect.stringContaining("could not be parsed"),
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not trust number_of_files=0 inside an error report", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-zero-files-error-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [],
					number_of_files: 0,
					error: "invalid config",
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]?.message).toContain("could not be parsed");
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-parsed-nothing",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not suppress stderr accompanying an otherwise expected no-files report", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-zero-files-stderr-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout:
					"No files found to lint. Please check your paths and ignore patterns.\n" +
					'{ "diagnostics": [], "number_of_files": 0 }',
				stderr: "Error: invalid configuration\n",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]?.message).toContain("could not be parsed");
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-parsed-nothing",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("reports a config-excluded file as skipped, not succeeded (dogfood #1985 review F2b/R2)", async () => {
		// Nested-config discovery means a file under a directory with its own
		// `.oxlintrc.json` ignorePatterns — or covered by a parent config's
		// ignorePatterns — makes oxlint report `number_of_files: 0` and an empty
		// `diagnostics` array. That is the SAME shape as a genuinely clean file:
		// zero diagnostics. Without reading `number_of_files`, "config excluded
		// this file" and "this file has no findings" are indistinguishable — the
		// AGENTS.md empty-result invariant (an empty result must distinguish
		// clean from errored/excluded).
		//
		// #1985 review round 2: a hand-built `JSON.stringify({...})` double
		// passed against a parser that bailed on real bytes, because real
		// oxlint prints a "No files found to lint." BANNER LINE to stdout
		// BEFORE the JSON when `number_of_files` is 0 — the #1946 fixture
		// discipline exists for exactly this gap. This is the VERBATIM stdout
		// `npx oxlint@1.79.0 --format json <excluded-file>` produced (exit 1,
		// stderr empty), captured against a real `.oxlintrc.json` with
		// `ignorePatterns` covering the target file.
		const env = setupTestEnvironment("pi-lens-oxlint-excluded-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			const CAPTURED_NO_FILES_STDOUT =
				"No files found to lint. Please check your paths and ignore patterns.\n" +
				'{ "diagnostics": [],\n' +
				'              "number_of_files": 0,\n' +
				'              "number_of_rules": 96,\n' +
				'              "threads_count": 16,\n' +
				'              "start_time": 0.009533\n' +
				"            }\n" +
				"            ";

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const log = vi.fn();
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
				log,
			} as never);

			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe("no-files-matched");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toHaveLength(0);
			// The existing latency runner record carries the structured skip reason.
			// This expected policy outcome must not enter the extension error log.
			expect(log).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("does not let a timed-out partial report masquerade as a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-timeout-partial-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: new Error("Process timed out after 30000ms"),
				failure: "timeout",
				status: null,
				stdout:
					'No files found to lint.\n{ "diagnostics": [], "number_of_files": 0 }',
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			// The shared #1994 outcome gate owns process failures. It records the
			// degradation and returns an unconfirmed skip, never the expected-policy
			// reason that would suppress failure accounting.
			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBeUndefined();
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-empty-result",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("carries the no-files reason through existing runner telemetry", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-skip-telemetry-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout:
					"No files found to lint. Please check your paths and ignore patterns.\n" +
					'{ "diagnostics": [], "number_of_files": 0 }',
				stderr: "",
			});

			const oxlintRunner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const {
				clearLatencyReports,
				dispatchForFile,
				getLatencyReports,
				RunnerRegistry,
			} = await import("../../../../clients/dispatch/dispatcher.js");
			clearLatencyReports();
			const registry = new RunnerRegistry();
			registry.register(oxlintRunner);
			const extensionLog = vi.fn();

			await dispatchForFile(
				{
					...createCtx(filePath, env.tmpDir),
					hasTool: async () => false,
					log: extensionLog,
				} as never,
				[{ mode: "all", runnerIds: ["oxlint"] }],
				registry,
			);

			const report = getLatencyReports().at(-1);
			expect(report?.runners).toContainEqual(
				expect.objectContaining({
					runnerId: "oxlint",
					status: "skipped",
					skipReason: "no-files-matched",
				}),
			);
			const runnerRow = logLatency.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) => entry.type === "runner" && entry.runnerId === "oxlint",
				);
			expect(runnerRow).toMatchObject({
				status: "skipped",
				metadata: { skipReason: "no-files-matched" },
			});
			expect(
				logLatency.mock.calls.some(
					([entry]) =>
						(entry as { phase?: string }).phase === "degradation_ledger",
				),
			).toBe(false);
			expect(extensionLog).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("rejects untyped free-text skip reasons at the latency boundary", async () => {
		const env = setupTestEnvironment("pi-lens-runner-skip-reason-boundary-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			const {
				clearLatencyReports,
				dispatchForFile,
				getLatencyReports,
				RunnerRegistry,
			} = await import("../../../../clients/dispatch/dispatcher.js");
			clearLatencyReports();
			const registry = new RunnerRegistry();
			registry.register({
				id: "malformed-skip",
				appliesTo: ["jsts"],
				priority: 1,
				enabledByDefault: true,
				async run() {
					return {
						status: "skipped",
						diagnostics: [],
						semantic: "none",
						skipReason: "free text from an untyped plugin",
					} as never;
				},
			});

			await dispatchForFile(
				createCtx(filePath, env.tmpDir) as never,
				[{ mode: "all", runnerIds: ["malformed-skip"] }],
				registry,
			);

			const latency = getLatencyReports().at(-1)?.runners.at(-1);
			expect(latency).toMatchObject({
				runnerId: "malformed-skip",
				status: "skipped",
			});
			expect(latency).not.toHaveProperty("skipReason");
			const runnerRow = logLatency.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) =>
						entry.type === "runner" && entry.runnerId === "malformed-skip",
				);
			expect(runnerRow).not.toHaveProperty("metadata.skipReason");
		} finally {
			env.cleanup();
		}
	});
});
