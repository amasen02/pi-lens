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
 * exists, and `handleSessionStart` only PUBLISHES this session's identity and
 * its config-resolution expectation — which is what the `handleSessionStart`
 * describe block asserts, through the real handler. The re-arm of the claim
 * itself belongs to index.ts's `session_start` closure, ahead of its own
 * `ensureLSPConfigInitialized`; `tests/index-config-resolved-session-wiring.
 * test.ts` drives that ordering end-to-end (review round 2, F1).
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
	sessionId: string;
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

	it("ONE row per session and root, not one per resolution", async () => {
		const { home, projectDir } = canonicalOnlyLayout();

		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		// Repeated resolutions of the SAME root — the session-start deferred
		// load and the first edit's ensure — collapse to one record.
		await loadLSPConfig(projectDir, home);
		await loadLSPConfig(projectDir, home);
		expect(await configResolvedRows()).toHaveLength(1);

		// A new session re-arms it, so the next session gets its own row.
		resetOncePerSessionPhases();
		await loadLSPConfig(projectDir, home);
		expect(await configResolvedRows()).toHaveLength(2);
	});

	/**
	 * #2526 review round 2, F3. `mcp/server.ts`'s `ensureReady` calls
	 * `ensureLspConfig` once per SERVED ROOT in one long-lived process. A claim
	 * keyed on the phase name alone recorded the first root and silently
	 * dropped every later one, so a legacy config document in project B could
	 * never reach a row and its "legacy without records" smell structurally
	 * could not fire.
	 */
	it("each served root records its own row (#2526 R2 F3)", async () => {
		const home = tmpRoot("pi-lens-cfgres-roots-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-cfgres-roots-global-");
		const canonicalRoot = path.join(home, "a");
		const legacyRoot = path.join(home, "b");
		write(path.join(canonicalRoot, ".pi-lens.json"), {
			lsp: { disabledServers: ["gopls"] },
		});
		write(path.join(legacyRoot, "pi-lens.json"), {
			warmFiles: ["src/main.ts"],
		});

		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		await loadLSPConfig(canonicalRoot, home);
		await loadLSPConfig(legacyRoot, home);

		const rows = await configResolvedRows();
		expect(rows, "the second served root never recorded").toHaveLength(2);
		// Both rows belong to the SAME session, so the analyzer's join matches
		// either one — the scoping widens coverage, it does not fork identity.
		expect(rows[0].metadata.sessionId).toBe(rows[1].metadata.sessionId);
		// Project B's legacy document is what the phase-only claim used to lose.
		expect(rows[1].metadata.documents).toEqual([
			{ tier: "project", file: "~/b/pi-lens.json", legacy: true },
		]);
		expect(rows[1].metadata.recordCount).toBeGreaterThan(0);
	});

	it("a /-vs-\\ spelling of one root does not buy a second row", async () => {
		const { home, projectDir } = canonicalOnlyLayout();
		const { loadLSPConfig, resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");
		resetLSPConfigStateForTests();
		await loadLSPConfig(projectDir, home);
		// The repo-wide path-key rule (#210): record one separator, resolve the
		// other. A raw-string claim key would double-count here.
		await loadLSPConfig(projectDir.split(path.sep).join("/"), home);
		await loadLSPConfig(projectDir.split(path.sep).join("\\"), home);
		expect(await configResolvedRows()).toHaveLength(1);
	});

	/**
	 * #2526 review round 2, S1. The loader's test reset owns ONE phase; the
	 * blanket `resetOncePerSessionPhases()` it used to call is the session
	 * boundary's, and it also re-mints the session identity — so a producer
	 * reaching for it wiped claims and identity that belong to other producers.
	 */
	it("resetLSPConfigStateForTests releases only its own phase (#2526 R2 S1)", async () => {
		const { claimPhaseOncePerSession, currentSessionRecordId } =
			await import("../../clients/latency-logger.js");
		const { resetLSPConfigStateForTests } =
			await import("../../clients/lsp/config.js");

		const sibling = "config_resolved_sibling_probe";
		expect(claimPhaseOncePerSession(sibling)).toBe(true);
		const before = currentSessionRecordId();

		resetLSPConfigStateForTests();

		expect(
			claimPhaseOncePerSession(sibling),
			"the loader's reset released a phase it does not own",
		).toBe(false);
		expect(
			currentSessionRecordId(),
			"the loader's reset re-minted the session identity",
		).toBe(before);
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
 * The session-start half, AFTER review round 2 F1: `handleSessionStart` must
 * NOT re-arm the claim. index.ts resolves this session's config in
 * `ensureLSPConfigInitialized` before it calls the handler, so a re-arm inside
 * the handler splits one session across two rows (the ensure's, then the
 * deferred load's). The re-arm belongs to index.ts's session_start closure —
 * `tests/index-config-resolved-session-wiring.test.ts` drives that ordering
 * end-to-end.
 *
 * What the handler DOES own is publishing the session's identity and its
 * config-resolution expectation, on both the quick and the full path. Quick
 * mode is used here deliberately: it returns long before the `session_start
 * cwd:` line, which is exactly why that line could never be the smell's
 * denominator.
 */
describe("handleSessionStart publishes the expectation, not a re-arm (#2526)", () => {
	function makeDeps(ctxCwd: string, dbg: (msg: string) => void): unknown {
		return withResidentBootstrap({
			ctxCwd,
			getFlag: () => false,
			notify: () => {},
			dbg,
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

	it("publishes this session's id and expectation, and re-arms nothing", async () => {
		const { home, projectDir } = canonicalOnlyLayout();
		const previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const globals = globalThis as { __piLensWarmupScheduled?: boolean };
		const previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
		const lines: string[] = [];
		try {
			const { loadLSPConfig, resetLSPConfigStateForTests } =
				await import("../../clients/lsp/config.js");
			const { currentSessionRecordId } =
				await import("../../clients/latency-logger.js");
			resetLSPConfigStateForTests();
			await loadLSPConfig(projectDir, home);
			const rows = await configResolvedRows();
			expect(rows).toHaveLength(1);

			// The REAL handler, standing in for index.ts's call after its ensure.
			const { handleSessionStart } =
				await import("../../clients/runtime-session.js");
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await handleSessionStart(
				makeDeps(projectDir, (msg) => lines.push(msg)) as never,
			);

			// The deferred load of the SAME session must not add a second row.
			await loadLSPConfig(projectDir, home);
			expect(
				await configResolvedRows(),
				"handleSessionStart re-armed the claim mid-session",
			).toHaveLength(1);

			const expectation = lines.filter((line) =>
				line.startsWith("session_start config-resolution "),
			);
			expect(
				expectation,
				"quick mode must still publish the expectation — it returns before `session_start cwd:`",
			).toHaveLength(1);
			expect(expectation[0]).toContain(
				`session=${currentSessionRecordId()} expected=true reason=ok`,
			);
			expect(expectation[0]).toContain(`session=${rows[0].metadata.sessionId}`);
		} finally {
			globals.__piLensWarmupScheduled = previousWarmup;
			if (previousStartupMode === undefined)
				delete process.env.PI_LENS_STARTUP_MODE;
			else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		}
	});

	it("a --no-lsp session publishes expected=false", async () => {
		const { projectDir } = canonicalOnlyLayout();
		const previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		const globals = globalThis as { __piLensWarmupScheduled?: boolean };
		const previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
		const lines: string[] = [];
		try {
			const { handleSessionStart } =
				await import("../../clients/runtime-session.js");
			const deps = makeDeps(projectDir, (msg) => lines.push(msg)) as {
				getFlag: (name: string) => boolean;
			};
			deps.getFlag = (name: string) => name === "no-lsp";
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await handleSessionStart(deps as never);

			const expectation = lines.filter((line) =>
				line.startsWith("session_start config-resolution "),
			);
			expect(expectation).toHaveLength(1);
			// The inverse F2 names: this session never resolves config by design,
			// so counting it produced a deficit no operator could ever clear.
			expect(expectation[0]).toContain("expected=false reason=no-lsp");
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
