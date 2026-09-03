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
	type EffectiveServerDecision,
} from "../../clients/effective-config.js";
import {
	explainServersForFile,
	initLSPConfig,
	isServerDisabled,
	loadLSPConfig,
	resetLSPConfigStateForTests,
	resetLSPConfigWarnCache,
	type ServerSelection,
} from "../../clients/lsp/config.js";
import {
	isOutsideAllSessionRoots,
	isSessionRootRegistered,
} from "../../clients/lsp/session-roots.js";
import { removeTempDirSync } from "./test-utils.js";

// The extension log is an ndjson sink, not the terminal; a fixture that
// deliberately carries a legacy location would otherwise spray test output.
// CAPTURED rather than discarded (#2427 review round 2, F6): the surface
// contract is that asking a question fires no user-facing notice, and a mock
// that throws the notices away cannot tell a suppressed one from an absent one.
const logSink = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			logSink.messages.push(entry.message);
		},
	};
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

/** Fixture layout keys, assembled so no literal path appears in the source. */
const GLOBAL_CONFIG = [".pi-lens", "config.json"].join("/");
const PROJECT_CONFIG = ["proj", ".pi-lens.json"].join("/");
const LEGACY_PROJECT_LSP = ["proj", "pi-lsp.json"].join("/");
const TYPOS_POINTER = ["", "lsp", "disabledServers", "0"].join("/");
const MARKSMAN_POINTER = ["", "lsp", "disabledServers", "1"].join("/");

/** A canonical-namespace document denying one server. */
function denyDoc(...ids: string[]): Record<string, unknown> {
	const lsp: Record<string, unknown> = { disabledServers: ids };
	const document: Record<string, unknown> = {};
	document.lsp = lsp;
	return document;
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
			{ file: "notes.md" },
		);

		const typos = view.file?.servers.find((entry) => entry.id === "typos");
		expect(typos).toBeDefined();
		expect(typos?.selected).toBe(false);
		expect(typos?.reason).toBe("disabled-by-config");
		expect(typos?.decidedBy?.tier).toBe("global");
		// The MEMBER pointer, not the array: the union is built from several
		// tiers and each surviving member carries the provenance of the tier that
		// contributed it (#2427 review round 2, F2).
		expect(typos?.decidedBy?.key).toBe(TYPOS_POINTER);
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
			{ file: "notes.md" },
		);
		const denied = new Set(
			view.file?.servers
				.filter((entry) => entry.reason === "disabled-by-config")
				.map((entry) => entry.id),
		);
		expect(denied.has("typos")).toBe(true);
		expect(denied.has("marksman")).toBe(true);
	});

	/**
	 * PER-MEMBER attribution (#2427 review round 2, F2).
	 *
	 * The deny union is one array built from several tiers, so one provenance
	 * entry cannot describe it: round 1 read the entry at the ARRAY pointer and
	 * stamped it on every disabled server, which reported the project-tier
	 * denial of marksman as a global one. The answer to "why can I not turn
	 * this back on" is per member, so the provenance is per member.
	 */
	it("attributes each denied server to the tier that actually denied IT", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CONFIG] = denyDoc("typos");
		files[PROJECT_CONFIG] = denyDoc("marksman");
		const layout: Layout = { files, startDir: "proj" };
		const result = await viewFor(layout, { file: "notes.md" });
		const servers = result.view.file?.servers ?? [];
		const byId = new Map(servers.map((entry) => [entry.id, entry] as const));
		expect(byId.get("typos")?.reason).toBe("disabled-by-config");
		expect(byId.get("marksman")?.reason).toBe("disabled-by-config");
		expect(byId.get("typos")?.decidedBy?.tier).toBe("global");
		expect(byId.get("marksman")?.decidedBy?.tier).toBe("project");
		// And each names the member it is the provenance OF, not the array.
		expect(byId.get("typos")?.decidedBy?.key).toBe(TYPOS_POINTER);
		expect(byId.get("marksman")?.decidedBy?.key).toBe(MARKSMAN_POINTER);
	});

	it("says why a server did NOT attach, distinguishing a denial from a mismatch", async () => {
		const { view } = await viewFor(
			{
				files: {
					".pi-lens/config.json": { lsp: { disabledServers: ["typos"] } },
				},
				startDir: "proj",
			},
			{ file: "notes.md" },
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

	/**
	 * The GATE ORDER, made non-vacuous (#2427 review round 2, F5).
	 *
	 * `selectionReason` documents that "you turned it off" outranks "this file
	 * is not yours" — a server the operator disabled reports
	 * `disabled-by-config` even when the extension would not have matched
	 * anyway. Every case that existed for it disabled a server the file DID
	 * match, so the documented order was never exercised and moving the disable
	 * check below the extension check left the suite green.
	 *
	 * Here `rust` is disabled and the file is markdown, so the two gates
	 * disagree and only the order can decide.
	 */
	it("reports a disabled server as disabled even when the extension would not match", async () => {
		const files: Record<string, unknown> = {};
		files[GLOBAL_CONFIG] = denyDoc("rust");
		const layout: Layout = { files, startDir: "proj" };
		const result = await viewFor(layout, { file: "notes.md" });
		const rust = result.view.file?.servers.find((entry) => entry.id === "rust");
		expect(rust).toBeDefined();
		expect(rust?.selected).toBe(false);
		expect(rust?.reason).toBe("disabled-by-config");
		// And the ordinary mismatch answer is still reachable, so this is a
		// discrimination test rather than a constant.
		const python = result.view.file?.servers.find(
			(entry) => entry.id === "python",
		);
		expect(python?.reason).toBe("extension-mismatch");
	});

	it("resolves the file's language and the runners that would dispatch for it", async () => {
		const { view } = await viewFor(
			{ files: {}, startDir: "proj" },
			{ file: "main.py" },
		);
		expect(view.file?.language).toBe("python");
		expect(view.file?.kind).toBe("python");
		expect(view.file?.tools.length).toBeGreaterThan(0);
		for (const tool of view.file?.tools ?? []) {
			expect([
				"selected",
				"not-registered-for-kind",
				"no-dispatch-plan",
			]).toContain(tool.reason);
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
			{ file: "notes.md" },
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

describe("effectiveConfig — asking must not report (#2427 rule 2)", () => {
	/**
	 * The per-file path drives `initLSPConfig`, and that used to fire the
	 * loader deprecation notices and consume the process-lifetime warn-once
	 * latch (review round 2, F6). A QUESTION that answers itself by
	 * warning the user — and then leaves the session-start load with nothing
	 * left to say — is the opposite of the surface contract.
	 */
	it("does not fire a legacy-location notice, and leaves the latch for the loader", async () => {
		const files: Record<string, unknown> = {};
		files[LEGACY_PROJECT_LSP] = { disabledServers: ["typos"] };
		const layout: Layout = { files, startDir: "proj" };
		logSink.messages.length = 0;
		const result = await viewFor(layout, { file: "notes.md" });
		// The view still SEES the legacy document and still counts its record.
		expect(result.view.documents.some((d) => d.legacy)).toBe(true);
		expect(result.view.recordCounts.PILENS_CFG_0003).toBeGreaterThanOrEqual(1);
		expect(logSink.messages).toEqual([]);

		// And the latch is untouched: the loader that OWNS the notice still says
		// it. This is the half that a bare "no output" assertion would miss —
		// suppressing by consuming the latch looks identical from inside the
		// query and is exactly the defect.
		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(result.home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = path.join(
			result.home,
			".pi-lens",
			"config.json",
		);
		try {
			await loadLSPConfig(result.projectDir, result.home);
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
		}
		expect(logSink.messages.join("\n")).toContain("deprecated");
	});
});

/**
 * A QUESTION MUST CHANGE NO SESSION STATE (#2427 review round 3, N2).
 *
 * The per-file half used to answer by calling `initLSPConfig(cwd)`, which is
 * the session-root registry's single writer and the `workspaceConfigs` LRU's
 * only producer. Both are session DECLARATIONS — "this process serves this
 * root, and here is its resolved server config" — so routing a read-only query
 * through them inverted the surface's own contract in two ways:
 *
 *  1. It enrolled a caller-supplied foreign directory as a served LSP root,
 *     permanently widening the #2052 access gate for a tree the session never
 *     opened.
 *  2. It wrote the 32-entry LRU. Enough queries against other directories
 *     EVICT a live root's config, after which `getConfigForFile` falls back to
 *     EMPTY and the operator's `disabledServers` denial silently lifts — and
 *     because `sessionRoots` is capped at 128, `shouldInitializeSessionRoot`
 *     never re-initializes the evicted root.
 *
 * The fix is that the query derives its own registered config from
 * `loadLSPConfig(..., { report: false })` and hands it to
 * `explainServersForFile`, so there is no write to delete later.
 */
describe("effectiveConfig — asking changes no session state (#2427 round 3)", () => {
	interface RootScenario {
		readonly home: string;
		readonly liveRoot: string;
		readonly foreignDir: string;
		/**
		 * A directory NESTED under `liveRoot` with its own `.pi-lens.json` —
		 * `repo/sub/.pi-lens.json` layering (config.ts header point 3). It
		 * denies `marksman` (P-E) and adds a custom server, `sub-only`, that
		 * exists nowhere else (P-F). The runtime registers config at exactly
		 * this directory for a file inside it —
		 * `ensureLSPConfigInitialized(path.dirname(filePath))` in
		 * `runtime-tool-call.ts:699-703` — never at `liveRoot`.
		 */
		readonly subDir: string;
		readonly restore: () => void;
	}

	/**
	 * One fixture home with a GLOBAL deny, a directory a session really
	 * initializes, and a second directory only ever named by a query. The env
	 * pin is held across the whole scenario rather than per call: the defect is
	 * about state that survives between calls, so a helper that reset the
	 * registry each time could not observe it.
	 */
	function rootScenario(): RootScenario {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-effcfg-r-"));
		tempRoots.push(home);
		const globalConfig = path.join(home, ".pi-lens", "config.json");
		const liveRoot = path.join(home, "live");
		const foreignDir = path.join(home, "foreign");
		const subDir = path.join(liveRoot, "sub");
		for (const dir of [
			path.dirname(globalConfig),
			liveRoot,
			foreignDir,
			subDir,
		]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const ids = ["typos"];
		const denySection = { disabledServers: ids };
		const denyDocument: Record<string, unknown> = { lsp: denySection };
		fs.writeFileSync(globalConfig, JSON.stringify(denyDocument));

		// The nested layer P13 exists to prove reachable: a project-level deny
		// (P-E) plus a custom server found NOWHERE else (P-F), both scoped to
		// `sub` alone so a query derived from `liveRoot` cannot see either.
		const subConfig = path.join(subDir, ".pi-lens.json");
		const subDocument: Record<string, unknown> = {
			lsp: {
				disabledServers: ["marksman"],
				servers: {
					"sub-only": {
						name: "Sub Only LSP",
						extensions: [".md"],
						command: "sub-only-lsp",
						args: ["--stdio"],
						rootMarkers: ["package.json"],
					},
				},
			},
		};
		fs.writeFileSync(subConfig, JSON.stringify(subDocument));

		const previousHome = process.env.PI_LENS_HOME;
		const previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		process.env.PI_LENS_CONFIG_PATH = globalConfig;
		resetLSPConfigStateForTests();
		resetLSPConfigWarnCache();
		const restore = (): void => {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousConfigPath === undefined)
				delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
			resetLSPConfigStateForTests();
		};
		return { home, liveRoot, foreignDir, subDir, restore };
	}

	/** P11: the queried cwd never becomes a served root. */
	it("does not enrol the queried directory as a session root", async () => {
		const scenario = rootScenario();
		try {
			// A session declares exactly ONE root, the way every real entry point
			// does. The registry is non-empty, so the #2052 gate is live and
			// declining is possible at all (it fails OPEN on an empty registry).
			await initLSPConfig(scenario.liveRoot);
			expect(isSessionRootRegistered(scenario.liveRoot)).toBe(true);
			expect(isSessionRootRegistered(scenario.foreignDir)).toBe(false);

			await effectiveConfig(queryFor(scenario.foreignDir, scenario.home));

			expect(isSessionRootRegistered(scenario.foreignDir)).toBe(false);
			// And the gate still refuses a file under it — asking about a tree is
			// not the same as the session serving that tree.
			const foreignFile = path.join(scenario.foreignDir, "notes.md");
			expect(isOutsideAllSessionRoots(foreignFile)).toBe(true);
		} finally {
			scenario.restore();
		}
	});

	/** P12: the LRU is never written, so a live root's config cannot be evicted. */
	it("leaves a live root's denial intact after 40 queries elsewhere", async () => {
		const scenario = rootScenario();
		try {
			await initLSPConfig(scenario.liveRoot);
			const liveFile = path.join(scenario.liveRoot, "notes.md");
			expect(isServerDisabled("typos", liveFile)).toBe(true);

			// More than the LRU's 32 slots. Every directory is a SIBLING of the
			// live root, so none of them is an ancestor that could legitimately
			// answer for `liveFile`.
			for (let index = 0; index < 40; index += 1) {
				const other = path.join(scenario.home, `other-${index}`);
				fs.mkdirSync(other, { recursive: true });
				await effectiveConfig(queryFor(other, scenario.home));
			}

			// The operator's denial is still in force ...
			expect(isServerDisabled("typos", liveFile)).toBe(true);
			// ... and the root is still served, so nothing has to reinitialize
			// it — which `shouldInitializeSessionRoot` would not do anyway.
			expect(isSessionRootRegistered(scenario.liveRoot)).toBe(true);
		} finally {
			scenario.restore();
		}
	}, 60_000);

	/**
	 * P13: deriving the config instead of reading the session registry must not
	 * change the ANSWER — including for a NESTED `.pi-lens.json` the runtime
	 * only reaches because it registers config at the FILE's OWN directory,
	 * never at the workspace root (#2427 review round 4, F1).
	 *
	 * `repo/sub/.pi-lens.json` layers a project-level deny (`marksman`, P-E)
	 * and a custom server that exists nowhere else (`sub-only`, P-F) onto the
	 * global deny (`typos`) that already covers the whole tree. The session
	 * mirrors what the runtime actually does for a tool call on a file under
	 * `sub`: it registers `liveRoot` once (session start) AND `subDir`
	 * separately (`ensureLSPConfigInitialized(path.dirname(filePath))`,
	 * `runtime-tool-call.ts:699-703`) — it never re-registers `liveRoot` for
	 * that call. `getConfigForFile` then answers with the deepest match,
	 * `subDir`.
	 *
	 * Before F1, the query derived its config from `cwd` (`liveRoot`) alone,
	 * which `resolvePiLensConfig` only walks UPWARD from — `subDir` is a
	 * CHILD of `liveRoot`, so its `.pi-lens.json` was never read. The query
	 * then answered `marksman` as `selected` (a denial the session enforces,
	 * silently under-reported) and omitted `sub-only` entirely (an addition
	 * the session serves, silently absent) — the differential this test pins.
	 */
	it("answers exactly what the session path answers for a nested config", async () => {
		const scenario = rootScenario();
		try {
			const subFile = path.join(scenario.subDir, "notes.md");
			await initLSPConfig(scenario.liveRoot);
			await initLSPConfig(scenario.subDir);
			const session = explainServersForFile(subFile).map(registryDecision);
			// Non-vacuous on all three axes: the full registry, the global deny,
			// the nested deny, and the nested addition.
			expect(session.length).toBeGreaterThan(30);
			expect(session.some(isDeniedTypos)).toBe(true);
			expect(session.some(isDeniedMarksman)).toBe(true);
			expect(session.some(isSelectedSubOnly)).toBe(true);

			const view = await effectiveConfig({
				cwd: scenario.liveRoot,
				homeDir: scenario.home,
				redact: true as const,
				file: path.join("sub", "notes.md"),
			});
			const queried = (view.file?.servers ?? []).map(viewDecision);
			expect(queried).toEqual(session);
		} finally {
			scenario.restore();
		}
	});

	function queryFor(cwd: string, homeDir: string) {
		const file = "notes.md";
		return { cwd, homeDir, redact: true as const, file };
	}

	interface Decision {
		readonly id: string;
		readonly selected: boolean;
		readonly reason: string;
	}

	function registryDecision(entry: ServerSelection): Decision {
		const id = entry.server.id;
		const selected = entry.selected;
		const reason = entry.reason;
		return { id, selected, reason };
	}

	function viewDecision(entry: EffectiveServerDecision): Decision {
		const id = entry.id;
		const selected = entry.selected;
		const reason = entry.reason;
		return { id, selected, reason };
	}

	function isDeniedTypos(entry: Decision): boolean {
		const denied = entry.reason === "disabled-by-config";
		return entry.id === "typos" && denied;
	}

	function isDeniedMarksman(entry: Decision): boolean {
		const denied = entry.reason === "disabled-by-config";
		return entry.id === "marksman" && denied;
	}

	function isSelectedSubOnly(entry: Decision): boolean {
		return entry.id === "sub-only" && entry.selected;
	}
});
