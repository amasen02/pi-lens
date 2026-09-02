/**
 * `effectiveConfig()` — the "why is X running / selected" query (#2427).
 *
 * Everything here drives the PRODUCTION path: real config files on disk, the
 * real `resolvePiLensConfig` + `initLSPConfig` sequence, and the real LSP
 * registry. Nothing is hand-fed a shaped resolution — the point of the surface
 * is that its answer and the runtime's answer are the same computation, and a
 * test that supplied its own resolution would prove the opposite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// Statically imported, NOT `await import()` inside the first test body. Both
// spellings work — each of these reads `PI_LENS_HOME` lazily, per call — but a
// dynamic import pays for the whole module graph (config resolution, the LSP
// registry, the dispatch plan) inside the first `it()`, where it counts
// against `testTimeout`. That is ~5s on this graph, i.e. a 5000ms default that
// passes or fails on machine load rather than on behavior.
import {
	effectiveConfig,
	type EffectiveConfigView,
} from "../../clients/effective-config.js";
import {
	loadLSPConfig,
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
} from "../../clients/lsp/config.js";
import { removeTempDirSync } from "./test-utils.js";

// The extension log is an ndjson sink, not the terminal; a fixture that
// deliberately carries a legacy location would otherwise spray test output.
// Same mock as tests/clients/config-golden-layouts.test.ts.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return { ...actual, logExtension: () => {} };
});

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) removeTempDirSync(root);
	}
});

interface Layout {
	/** Files written relative to the FAKE HOME. */
	readonly files: Readonly<Record<string, unknown>>;
	/** Project directory, relative to the fake home. */
	readonly startDir: string;
}

/**
 * Lay a fixture home out on disk and run `effectiveConfig` against it exactly
 * the way a session does: `PI_LENS_HOME` / `PI_LENS_CONFIG_PATH` point the
 * global tier at the fixture, and `homeDir` is the ceiling the project walk
 * stops at (also the `$HOME` the redaction rewrites against).
 */
async function viewFor(
	layout: Layout,
	options: { file?: string } = {},
): Promise<{
	view: EffectiveConfigView;
	home: string;
	projectDir: string;
}> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-"));
	tempRoots.push(home);
	for (const [relative, content] of Object.entries(layout.files)) {
		const target = path.join(home, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify(content, null, 2));
	}
	const projectDir = path.join(home, layout.startDir);
	fs.mkdirSync(projectDir, { recursive: true });

	const previousHome = process.env.PI_LENS_HOME;
	const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
	process.env.PI_LENS_CONFIG_PATH = path.join(home, ".pi-lens", "config.json");

	resetLSPConfigStateForTests();
	resetLSPConfigWarnCache();

	try {
		const view = await effectiveConfig({
			cwd: projectDir,
			homeDir: home,
			redact: true,
			...(options.file === undefined ? {} : { file: options.file }),
		});
		return { view, home, projectDir };
	} finally {
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousConfigPath === undefined)
			delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	}
}

describe("effectiveConfig — provenance of the resolution", () => {
	it("names the file and tier every resolved leaf came from, without carrying values", async () => {
		const { view } = await viewFor({
			files: {
				".pi-lens/config.json": { maxProjectFiles: 8000 },
				"proj/.pi-lens.json": { ignore: ["dist/**"] },
			},
			startDir: "proj",
		});

		expect(view.documents.map((entry) => entry.tier)).toEqual([
			"global",
			"project",
		]);
		const byKey = new Map(view.provenance.map((entry) => [entry.key, entry]));
		expect(byKey.get("/maxProjectFiles")?.tier).toBe("global");
		expect(byKey.get("/ignore")?.tier).toBe("project");
		// Sources only. A value that reached this projection would be a leak the
		// shape is supposed to make impossible.
		expect(JSON.stringify(view.provenance)).not.toContain("8000");
		expect(JSON.stringify(view.provenance)).not.toContain("dist/**");
		expect(view.provenanceCounts.global).toBeGreaterThan(0);
		expect(view.provenanceCounts.project).toBeGreaterThan(0);
		expect(view.provenanceCounts.cli).toBe(0);
	});

	it("counts records by their stable code instead of re-rendering the prose", async () => {
		const { view } = await viewFor({
			// A legacy ROOT key inside a canonical file: one PILENS_CFG_0002 per
			// (file, key), and no user-facing warning fired by the question itself.
			files: { "proj/.pi-lens.json": { disabledServers: ["typos"] } },
			startDir: "proj",
		});
		expect(view.recordCounts.PILENS_CFG_0002).toBeGreaterThanOrEqual(1);
	});
});

describe("effectiveConfig — why is X running (#2415 AC)", () => {
	/**
	 * THE acceptance criterion: a global deny that a project file tries to
	 * clear resolves to DENIED, attributed to the global tier.
	 *
	 * Before #2427 this scenario resolved the other way through the production
	 * loader — `loadLSPConfig` returned `disabledServers: []` attributed to
	 * `project`, so repository content re-enabled a server the operator had
	 * turned off. The deny machinery existed (`config-core/deny.ts`, #2440) but
	 * no schema node annotated it, so `merge()` never reached it.
	 */
	it("reports a globally denied server as denied, with the GLOBAL provenance, when the project tries to re-enable it", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
					"proj/.pi-lens.json": { lsp: { disabledServers: [] } },
				},
				startDir: "proj",
			},
			{ file: "proj/notes.md" },
		);

		const typos = view.file?.servers.find((entry) => entry.id === "typos");
		expect(typos).toBeDefined();
		expect(typos?.selected).toBe(false);
		expect(typos?.reason).toBe("disabled-by-config");
		expect(typos?.decidedBy?.tier).toBe("global");
		expect(typos?.decidedBy?.key).toBe("/lsp/disabledServers");
		// And the resolution itself agrees — the view is not reporting a decision
		// the merge did not make.
		const leaf = view.provenance.find(
			(entry) => entry.key === "/lsp/disabledServers",
		);
		expect(leaf?.tier).toBe("global");
	});

	it("the LOADER agrees — `loadLSPConfig` hands the runtime the denied set, not the project's empty one", async () => {
		// The view is only worth having if it describes what actually runs. This
		// asserts the same scenario one layer down, at the production loader that
		// feeds `initLSPConfig`'s disable set: pre-#2427 it returned `[]` here.
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-"));
		tempRoots.push(home);
		const global = path.join(home, ".pi-lens", "config.json");
		fs.mkdirSync(path.dirname(global), { recursive: true });
		fs.writeFileSync(
			global,
			JSON.stringify({ lsp: { disabledServers: ["typos"] } }),
		);
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: [] } }),
		);

		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = global;
		try {
			resetLSPConfigWarnCache();
			expect((await loadLSPConfig(projectDir, home)).disabledServers).toEqual([
				"typos",
			]);
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
		}
	});

	it("a server the project denies is denied too — the union only ever grows", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
					"proj/.pi-lens.json": { lsp: { disabledServers: ["marksman"] } },
				},
				startDir: "proj",
			},
			{ file: "proj/notes.md" },
		);
		const denied = new Set(
			view.file?.servers
				.filter((entry) => entry.reason === "disabled-by-config")
				.map((entry) => entry.id),
		);
		expect(denied.has("typos")).toBe(true);
		expect(denied.has("marksman")).toBe(true);
	});

	it("says why a server did NOT attach, distinguishing a denial from a mismatch", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
				},
				startDir: "proj",
			},
			{ file: "proj/notes.md" },
		);
		const reasons = new Map(
			view.file?.servers.map((entry) => [entry.id, entry.reason]),
		);
		expect(reasons.get("typos")).toBe("disabled-by-config");
		// A Rust server has nothing to do with a markdown file, and that is a
		// different answer from "you turned it off".
		expect(reasons.get("rust")).toBe("extension-mismatch");
		expect(view.file?.language).toBe("markdown");
	});

	it("resolves the file's language and the runners that would dispatch for it", async () => {
		const { view } = await viewFor(
			{ files: {}, startDir: "proj" },
			{ file: "proj/main.py" },
		);
		expect(view.file?.language).toBe("python");
		expect(view.file?.kind).toBe("python");
		expect(view.file?.tools.length).toBeGreaterThan(0);
		for (const tool of view.file?.tools ?? []) {
			expect(["selected", "not-registered-for-kind", "no-dispatch-plan"]).toContain(
				tool.reason,
			);
		}
	});
});

describe("effectiveConfig — redaction is unconditional", () => {
	it("never carries an env value, an argv tail, or an absolute $HOME path", async () => {
		const { view, home, projectDir } = await viewFor(
			{
				files: {
					"proj/.pi-lens.json": {
						lsp: {
							servers: {
								"secret-server": {
									name: "Secret",
									extensions: [".md"],
									command: "my-lsp",
									args: ["--stdio", "--token", "ARGV_SECRET_ZZZ"],
									env: { AUTH_TOKEN: "ENV_SECRET_ZZZ" },
								},
							},
						},
					},
				},
				startDir: "proj",
			},
			{ file: "proj/notes.md" },
		);

		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("ARGV_SECRET_ZZZ");
		expect(serialized).not.toContain("ENV_SECRET_ZZZ");
		// The absolute fixture $HOME must not appear anywhere: every path is
		// rewritten home-relative.
		expect(serialized).not.toContain(JSON.stringify(home).slice(1, -1));
		expect(view.cwd.startsWith("~/")).toBe(true);
		expect(view.file?.path.startsWith("~/")).toBe(true);
		for (const document of view.documents) {
			expect(document.file.startsWith("~/")).toBe(true);
		}

		// What DOES survive is the part that answers the question: the server
		// exists, it came from the project file, and this is the binary.
		const custom = view.file?.servers.find(
			(entry) => entry.id === "secret-server",
		);
		expect(custom?.spec?.command).toBe("my-lsp");
		expect(custom?.spec?.argvCount).toBe(4);
		expect(custom?.spec?.envNames).toEqual(["AUTH_TOKEN"]);
		expect(custom?.decidedBy?.tier).toBe("project");
		expect(projectDir).toContain("proj");
	});

	it("reports a legacy config location as legacy rather than silently reading it", async () => {
		const { view } = await viewFor({
			files: { "proj/pi-lsp.json": { disabledServers: ["typos"] } },
			startDir: "proj",
		});
		const legacy = view.documents.filter((document) => document.legacy);
		expect(legacy.length).toBe(1);
		expect(legacy[0].file.endsWith("pi-lsp.json")).toBe(true);
	});
});
