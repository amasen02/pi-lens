/**
 * #2413: a formatter whose executable is proven absent must surface as a typed
 * `unavailable` outcome — never a code failure. These tests exercise the REAL
 * seams: `formatFile` (resolver-proven absence AND the static-fallback ENOENT
 * belt), `runFormatPhase` (the deferred-drain feeder), and the widget footer.
 *
 * Pre-fix, every one of these paths collapsed an unavailable tool into
 * `success: false` — counted as a failed file, requeued, and rendered with a
 * red `fmt-failed` marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

// formatters.ts owns a LOCAL `which` (availability-latched) that probes via
// `safeSpawnAsync("where"/"which", [cmd])`, so a not-found tool is simulated by
// making the probe exit nonzero — not by mocking the imported `which`.
const safeSpawnAsync = vi.fn();
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	which: vi.fn(async () => null),
}));

const WHICH_COMMANDS = new Set(["where", "which"]);
const isWhichProbe = (call: unknown[]) =>
	WHICH_COMMANDS.has(call[0] as string);
/** Every real format spawn (i.e. not a `where`/`which` availability probe). */
const formatSpawns = () => safeSpawnAsync.mock.calls.filter((c) => !isWhichProbe(c));

async function loadFormatters() {
	return import("../../clients/formatters.js");
}

describe("formatFile classifies an unavailable tool distinctly from a failure (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		// Default: every `where`/`which` probe reports the tool absent.
		safeSpawnAsync.mockResolvedValue({ status: 1, stdout: "", stderr: "" });
	});

	it("a resolver returning FORMATTER_UNAVAILABLE never spawns and is not a failure", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-seam-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "const x=1\n");
			const { formatFile, FORMATTER_UNAVAILABLE } = await loadFormatters();
			const formatter = {
				name: "synthetic",
				command: ["synthetic", "$FILE"],
				extensions: [".ts"],
				detect: async () => true,
				resolveCommand: async () => FORMATTER_UNAVAILABLE,
			};

			const result = await formatFile(filePath, formatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
			// The static fallback must never be spawned after proven absence.
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("real oxfmt with no executable resolves to unavailable, never spawning oxfmt", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-oxfmt-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, "const x=1\n");

			// No node_modules/.bin/oxfmt under the temp dir, and every `where oxfmt`
			// probe exits 1 — the exact reported ENOENT trap. The resolver must now
			// prove the tool unavailable rather than hand bare `oxfmt` to the spawn.
			const { formatFile, oxfmtFormatter } = await loadFormatters();
			const result = await formatFile(filePath, oxfmtFormatter);

			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			// A which-probe is allowed; a FORMAT spawn of oxfmt is not.
			expect(formatSpawns()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("static-fallback spawn tool-not-found is unavailable, not a failure (belt)", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-belt-");
		try {
			const filePath = path.join(env.tmpDir, "a.py");
			fs.writeFileSync(filePath, "x=1\n");

			// black only probes a venv; with none it returns null and legitimately
			// falls back to the bare static `black`. When that binary is missing,
			// the spawn boundary reports a typed tool-not-found failure — which is
			// unavailable infrastructure, not a formatting failure.
			safeSpawnAsync.mockResolvedValue({
				status: null,
				stdout: "",
				stderr: "",
				error: new Error("spawn black ENOENT"),
				failure: "spawn",
				spawnFailure: {
					kind: "tool-not-found",
					message: "Cannot spawn black: tool not found (spawn black ENOENT)",
				},
			});

			const { formatFile, blackFormatter } = await loadFormatters();
			const result = await formatFile(filePath, blackFormatter);

			expect(safeSpawnAsync).toHaveBeenCalled(); // the static attempt happened
			expect(result.outcome).toBe("unavailable");
			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("preserves a real nonzero-exit failure as outcome=failed", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-realfail-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");
			// A tool that RAN and exited nonzero — never an availability problem.
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Error: unknown command "hcl" for "terragrunt"',
			});

			const { formatFile, terragruntHclFormatter } = await loadFormatters();
			const result = await formatFile(filePath, terragruntHclFormatter);

			expect(result.outcome).toBe("failed");
			expect(result.success).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("a clean rewrite is outcome=formatted, an unchanged run is outcome=unchanged", async () => {
		const env = setupTestEnvironment("pi-lens-unavail-ok-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals   {}\n");
			const { formatFile, terragruntHclFormatter } = await loadFormatters();

			safeSpawnAsync.mockImplementation(async () => {
				fs.writeFileSync(filePath, "locals {}\n");
				return { status: 0, stdout: "", stderr: "" };
			});
			const changedResult = await formatFile(filePath, terragruntHclFormatter);
			expect(changedResult.outcome).toBe("formatted");
			expect(changedResult.changed).toBe(true);

			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
			const noopResult = await formatFile(filePath, terragruntHclFormatter);
			expect(noopResult.outcome).toBe("unchanged");
			expect(noopResult.changed).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("runFormatPhase feeds the deferred drain (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("routes unavailable out of formatFailures and records it once, distinctly", async () => {
		const { runFormatPhase } = await import("../../clients/pipeline.js");
		const {
			getDegradationSummary,
			resetDegradationLedger,
		} = await import("../../clients/degradation-ledger.js");
		resetDegradationLedger();

		const filePath = path.join(process.cwd(), "unavailable-fixture.ts");
		const fakeService = {
			recordRead: () => {},
			formatFile: async () => ({
				filePath,
				formatters: [
					{
						name: "oxfmt",
						success: true,
						changed: false,
						outcome: "unavailable" as const,
						error: "oxfmt: formatter executable not found",
					},
				],
				anyChanged: false,
				allSucceeded: true,
			}),
		};

		const result = await runFormatPhase(
			filePath,
			() => fakeService as never,
			() => {},
		);

		// Never a formatter FAILURE, and never listed as a formatter that ran.
		expect(result.formatFailures).toEqual([]);
		expect(result.formattersUsed).toEqual([]);
		expect(result.formatUnavailable).toEqual([
			{ formatter: "oxfmt", reason: "oxfmt: formatter executable not found" },
		]);

		// Observability: a distinct `formatter-unavailable` ledger kind — NOT the
		// `formatter-failure` bucket (recurring defect shape 10).
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("formatter-unavailable");
		expect(kinds).not.toContain("formatter-failure");
	});

	it("still routes a real failure into formatFailures", async () => {
		const { runFormatPhase } = await import("../../clients/pipeline.js");
		const filePath = path.join(process.cwd(), "failing-fixture.ts");
		const fakeService = {
			recordRead: () => {},
			formatFile: async () => ({
				filePath,
				formatters: [
					{
						name: "biome",
						success: false,
						changed: false,
						outcome: "failed" as const,
						error: "biome exited with status 2",
					},
				],
				anyChanged: false,
				allSucceeded: false,
			}),
		};

		const result = await runFormatPhase(
			filePath,
			() => fakeService as never,
			() => {},
		);

		expect(result.formatUnavailable).toEqual([]);
		expect(result.formatFailures).toEqual(["biome: biome exited with status 2"]);
	});
});

describe("widget footer never marks an unavailable tool as failed (#2413)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	const theme = { fg: (_color: string, s: string) => s };

	it("never marks an unavailable formatter fmt-failed, even when success is false", async () => {
		const { recordFormatter, renderWidget, clearWidgetState } = await import(
			"../../clients/widget-state.js"
		);
		clearWidgetState();

		// The production combo (success:true) already avoids the marker, so to
		// prove the guard is load-bearing this records the harder case: an
		// `unavailable` outcome carried on a success:false record must STILL never
		// earn the red `fmt-failed` marker (recurring defect shape 10).
		const unavailPath = path.join(process.cwd(), "unavail.ts");
		recordFormatter(unavailPath, "oxfmt", false, false, "unavailable");

		// A genuine failure keeps its marker.
		const failedPath = path.join(process.cwd(), "failed.ts");
		recordFormatter(failedPath, "biome", false, false, "failed");

		// Narrow width -> vertical rows, which carry the fmt-failed marker.
		const rendered = renderWidget(60, theme).join("\n");

		expect(rendered).not.toContain("fmt-failed:oxfmt");
		expect(rendered).toContain("fmt-failed:biome");
	});
});
