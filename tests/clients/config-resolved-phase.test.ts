/**
 * #2526: config resolution gains POSITIVE observability.
 *
 * Before this, the whole Phase 0 config stack (registry #2429, core #2440,
 * canonical files #2456, effective-config + deny union #2513) proved itself on
 * a correct canonical-only layout only by the ABSENCE of `PILENS_CFG_*` rows —
 * the silent-success gap AGENTS.md warns about. `config_resolved` is the row
 * that says the resolution ran, what contributed, and what it produced.
 *
 * ## Real sinks, not logger mocks (AGENTS.md, #1742 direction)
 *
 * Every assertion below reads the bytes `logLatency` / `logSessionStart`
 * actually wrote, from the worker's hermetic `PI_LENS_HOME`, with
 * `PI_LENS_TEST_MODE=0` scoped to this file — the sanctioned opt-out. A module
 * mock of the logger would assert against an imaginary surface; the smell
 * analyzer this issue also extends reads the real file.
 *
 * ## Why `loadLSPConfig` is the seam under test
 *
 * It is the ONE funnel every production config resolution goes through:
 * `initLSPConfig` (session start, and each served root), the warm MCP boot's
 * `ensureLspConfig`, and `ensureLSPConfigInitialized` on the first edit. The
 * session-start hook itself resolves NO config on its interactive path — the
 * resolution is deliberately deferred into a `setImmediate` (`runtime-session.
 * ts`, "the config walk … never runs on the interactive path"), and quick mode
 * returns before even that. So the record is written where the resolution
 * exists, and `handleSessionStart` only re-arms the once-per-session latch —
 * which is what the last describe block asserts, through the real handler.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
	resetOncePerSessionPhases,
} from "../../clients/latency-logger.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../../clients/sessionstart-logger.js";
import { removeTempDirSync } from "./test-utils.js";

interface ConfigResolvedMetadata {
	documents: Array<{ tier: string; file: string; legacy: boolean }>;
	countsByTier: Record<string, number>;
	recordCount: number;
	deniedServers: number;
	resolveMs: number;
}

const roots: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function write(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Every `config_resolved` phase row currently on disk. */
async function configResolvedRows(): Promise<
	Array<{
		durationMs: number;
		filePath: string;
		metadata: ConfigResolvedMetadata;
	}>
> {
	await flushLatencyLog();
	const file = getLatencyLogPath();
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map(
			(line) =>
				JSON.parse(line) as {
					phase?: string;
					durationMs?: number;
					filePath?: string;
					metadata?: unknown;
				},
		)
		.filter((entry) => entry.phase === "config_resolved")
		.map((entry) => ({
			durationMs: entry.durationMs ?? -1,
			filePath: entry.filePath ?? "",
			metadata: entry.metadata as ConfigResolvedMetadata,
		}));
}

/**
 * sessionstart.log has no truncate hook, so isolate this test's own writes by
 * byte offset rather than by clearing a machine-global file another suite may
 * be appending to.
 */
function sessionStartOffset(): number {
	return fs.existsSync(SESSIONSTART_LOG_FILE)
		? fs.statSync(SESSIONSTART_LOG_FILE).size
		: 0;
}

async function sessionStartLinesSince(offset: number): Promise<string[]> {
	await flushSessionStartLog();
	if (!fs.existsSync(SESSIONSTART_LOG_FILE)) return [];
	const buffer = fs.readFileSync(SESSIONSTART_LOG_FILE);
	// A rotation between the two reads would make the offset meaningless; a
	// shrunken file means exactly that, so read the whole (new) file instead.
	const tail = buffer.length < offset ? buffer : buffer.subarray(offset);
	return tail
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.includes("config resolved "));
}

let previousTestMode: string | undefined;
let previousHome: string | undefined;
let previousConfigPath: string | undefined;

beforeEach(async () => {
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	previousHome = process.env.PI_LENS_HOME;
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_TEST_MODE = "0";
	resetIgnoredConfigWarnCache();
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	await flushLatencyLog();
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	resetIgnoredConfigWarnCache();
	const { resetLSPConfigStateForTests } =
		await import("../../clients/lsp/config.js");
	resetLSPConfigStateForTests();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

/** A workspace whose only config document is the canonical `.pi-lens.json`. */
function canonicalOnlyLayout(): { home: string; projectDir: string } {
	const home = tmpRoot("pi-lens-cfgres-canon-home-");
	process.env.PI_LENS_HOME = tmpRoot("pi-lens-cfgres-canon-global-");
	const projectDir = path.join(home, "proj");
	write(path.join(projectDir, ".pi-lens.json"), {
		lsp: { disabledServers: ["gopls", "rust"] },
	});
	return { home, projectDir };
}

/** A workspace whose config lives in a DEPRECATED location (`pi-lens.json`). */
function legacyLayout(): { home: string; projectDir: string } {
	const home = tmpRoot("pi-lens-cfgres-legacy-home-");
	process.env.PI_LENS_HOME = tmpRoot("pi-lens-cfgres-legacy-global-");
	const projectDir = path.join(home, "proj");
	write(path.join(projectDir, "pi-lens.json"), { warmFiles: ["src/main.ts"] });
	return { home, projectDir };
}

describe("config_resolved: the session's one positive config record (#2526)", () => {
	it("canonical-only layout: one row, redacted, recordCount 0", async () => {
		const { home, projectDir } = canonicalOnlyLayout();
		const offset = sessionStartOffset();

		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		await loadLSPConfig(projectDir, home);

		const rows = await configResolvedRows();
		expect(rows, "expected exactly one config_resolved row").toHaveLength(1);
		const { metadata } = rows[0];

		// documents[] — one entry, home-relative, not legacy.
		expect(metadata.documents).toEqual([
			{ tier: "project", file: "~/proj/.pi-lens.json", legacy: false },
		]);
		// A canonical-only layout produces no migration/notice record. That zero
		// IS the fact this issue exists to make visible: before it, the same
		// state was indistinguishable from "config resolution never ran".
		expect(metadata.recordCount).toBe(0);
		// The deny union's size, not its members.
		expect(metadata.deniedServers).toBe(2);
		expect(metadata.countsByTier.project).toBeGreaterThan(0);
		expect(metadata.countsByTier).toMatchObject({
			builtin: 0,
			global: 0,
			"nested-project": 0,
			env: 0,
			cli: 0,
			host: 0,
		});
		expect(metadata.resolveMs).toBeGreaterThanOrEqual(0);
		expect(rows[0].durationMs).toBe(metadata.resolveMs);

		// REDACTION: no config VALUE and no absolute `$HOME` may reach the log.
		const serialized = JSON.stringify(metadata);
		expect(serialized).not.toContain("gopls");
		expect(serialized).not.toContain(home);

		// One matching sessionstart.log line summarising the same facts.
		const lines = await sessionStartLinesSince(offset);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			"config resolved documents=1 legacy=0 records=0 deniedServers=2",
		);
	});

	it("legacy layout: the document is flagged legacy and records are produced", async () => {
		const { home, projectDir } = legacyLayout();
		const offset = sessionStartOffset();

		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		await loadLSPConfig(projectDir, home);

		const rows = await configResolvedRows();
		expect(rows).toHaveLength(1);
		const { metadata } = rows[0];
		expect(metadata.documents).toEqual([
			{ tier: "project", file: "~/proj/pi-lens.json", legacy: true },
		]);
		// The invariant the "config resolution" smell checks: a legacy document
		// present with ZERO records means the deprecation machinery went silent.
		expect(metadata.recordCount).toBeGreaterThan(0);

		const lines = await sessionStartLinesSince(offset);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/config resolved documents=1 legacy=1 records=[1-9]\d* deniedServers=0/,
		);
	});

	it("ONE row per session, not one per resolution", async () => {
		const { home, projectDir } = canonicalOnlyLayout();

		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		// Three resolutions — the session-start deferred load, a served root's
		// init, and the first edit's ensure — collapse to one record.
		await loadLSPConfig(projectDir, home);
		await loadLSPConfig(projectDir, home);
		await loadLSPConfig(path.join(projectDir, "nested"), home);
		expect(await configResolvedRows()).toHaveLength(1);

		// A new session re-arms it, so the next session gets its own row.
		resetOncePerSessionPhases();
		await loadLSPConfig(projectDir, home);
		expect(await configResolvedRows()).toHaveLength(2);
	});

	it("no second resolution: the record reads the resolution its caller performed", async () => {
		const { home, projectDir } = canonicalOnlyLayout();

		// The facade rule (#2513). `summarizeConfigResolution` is pure over a
		// resolution the caller already holds, so producing the record cannot
		// re-walk the config tree — asserted by DELETING every config document
		// after the resolution and before the projection: a second walk would
		// find nothing, and the summary would be empty.
		const { resolvePiLensConfig, summarizeConfigResolution } =
			await import("../../clients/config-resolve.js");
		const resolution = resolvePiLensConfig({
			cwd: projectDir,
			homeDir: home,
		});
		fs.rmSync(path.join(projectDir, ".pi-lens.json"));
		const summary = summarizeConfigResolution(resolution, home);
		expect(summary.documents).toEqual([
			{ tier: "project", file: "~/proj/.pi-lens.json", legacy: false },
		]);
	});
});

/**
 * The session-start half: `handleSessionStart` re-arms the latch, so the NEXT
 * resolution of the new session writes its own record instead of inheriting
 * the previous session's "already recorded" claim (catalog shape 17). Quick
 * mode is used deliberately — it is the mode every process's first session
 * takes, and it resolves NO config on its interactive path, so it is also the
 * mode in which forgetting the re-arm would be invisible.
 */
describe("handleSessionStart re-arms the record for the new session (#2526)", () => {
	function makeDeps(ctxCwd: string): unknown {
		return withResidentBootstrap({
			ctxCwd,
			getFlag: () => false,
			notify: () => {},
			dbg: () => {},
			log: () => {},
			runtime: new RuntimeCoordinator(),
			metricsClient: { reset: () => {} },
			cacheManager: { writeCache: () => {}, readCache: () => null },
			todoScanner: { scanDirectory: () => ({ items: [] }) },
			astGrepClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
				scanExports: async () => new Map(),
			},
			biomeClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			ruffClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			knipClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			jscpdClient: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			depChecker: {
				isAvailable: () => false,
				ensureAvailable: async () => false,
			},
			testRunnerClient: {
				detectRunner: () => null,
				runTestFile: () => ({ failed: 0, error: false }),
			},
			goClient: { isGoAvailableAsync: async () => false },
			rustClient: { isAvailableAsync: async () => false },
			ensureTool: async () => null,
			cleanStaleTsBuildInfo: () => [],
			resetDispatchBaselines: () => {},
			resetLSPService: () => {},
		});
	}

	it("a second session gets its own row", async () => {
		const { home, projectDir } = canonicalOnlyLayout();
		const previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const globals = globalThis as { __piLensWarmupScheduled?: boolean };
		const previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
		try {
			const { loadLSPConfig, resetLSPConfigStateForTests } =
				await import("../../clients/lsp/config.js");
			resetLSPConfigStateForTests();
			await loadLSPConfig(projectDir, home);
			expect(await configResolvedRows()).toHaveLength(1);

			// A fresh session, through the REAL handler.
			const { handleSessionStart } =
				await import("../../clients/runtime-session.js");
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await handleSessionStart(makeDeps(projectDir) as any);

			await loadLSPConfig(projectDir, home);
			expect(
				await configResolvedRows(),
				"handleSessionStart did not re-arm the config_resolved latch",
			).toHaveLength(2);
		} finally {
			globals.__piLensWarmupScheduled = previousWarmup;
			if (previousStartupMode === undefined)
				delete process.env.PI_LENS_STARTUP_MODE;
			else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		}
	});
});

describe("MCP parity: the warm boot's config resolution records too (#2526)", () => {
	it("ensureLspConfig — the MCP server's boot seam — writes the row", async () => {
		const { projectDir } = canonicalOnlyLayout();
		const offset = sessionStartOffset();

		// `mcp/server.ts`'s `ensureReady` calls exactly this, before
		// `runSessionStart` drives `handleSessionStart`. It resolves against the
		// real `os.homedir()` (that is `initLSPConfig`'s own hard-wired seam), so
		// this asserts the RECORD, not a document list a temp `$HOME` would fix.
		const { resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		const { ensureLspConfig } = await import("../../clients/lens-engine.js");
		await ensureLspConfig(projectDir);

		const rows = await configResolvedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata.documents.length).toBeGreaterThanOrEqual(1);
		expect(rows[0].metadata.deniedServers).toBeGreaterThanOrEqual(2);
		expect(await sessionStartLinesSince(offset)).toHaveLength(1);
		// `lens-engine.js` is the widest import in the tree; a cold transform of
		// it alone can exceed the 5s default before the assertion is reached.
	}, 30000);
});
