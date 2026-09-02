import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const dirs: string[] = [];
const defaultGlobalDir = process.env.PI_LENS_HOME;

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	if (defaultGlobalDir === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = defaultGlobalDir;
	// #2418 review round 3, S3. The ignored-config warn latch is
	// process-lifetime and shared by all three loaders, so without an explicit
	// clear these cases only stayed independent because every fixture happened
	// to land in a fresh mkdtemp path — a property of the fixture, not of the
	// test. The loader now exports the same reset seam lens-config and
	// project-lens-config do.
	const { resetLSPConfigWarnCache } =
		await import("../../../clients/lsp/config.js");
	resetLSPConfigWarnCache();
});

describe("loadLSPConfig global configuration (#870)", () => {
	it("applies global configuration when the project has no config", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					global: {
						name: "Global",
						extensions: [".global"],
						command: "global-lsp",
					},
				},
				disabledServers: ["typescript"],
				warmFiles: ["src/global.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toMatchObject({
			servers: { global: { command: "global-lsp" } },
			disabledServers: ["typescript"],
			warmFiles: ["src/global.ts"],
		});
	});

	it("merges maps by id and replaces project-owned array fields", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Global", extensions: [".g"], command: "global" },
					globalOnly: {
						name: "Global only",
						extensions: [".go"],
						command: "global-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "check" } } },
					go: { initializationOptions: { gofumpt: true } },
				},
				disabledServers: ["global-disabled"],
				warmFiles: ["global.ts"],
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".pi-lens"));
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					shared: { name: "Project", extensions: [".p"], command: "project" },
					projectOnly: {
						name: "Project only",
						extensions: [".po"],
						command: "project-only",
					},
				},
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
					nix: { initializationOptions: { nixpkgs: { expr: "global" } } },
				},
				disabledServers: [],
				warmFiles: ["project.ts"],
			}),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir);

		expect(Object.keys(config.servers ?? {}).sort()).toEqual([
			"globalOnly",
			"projectOnly",
			"shared",
		]);
		expect(config.servers?.shared.command).toBe("project");
		expect(Object.keys(config.serverOverrides ?? {}).sort()).toEqual([
			"go",
			"nix",
			"rust",
		]);
		expect(config.serverOverrides?.rust.initializationOptions).toEqual({
			check: { command: "clippy" },
		});
		expect(config.disabledServers).toEqual([]);
		expect(config.warmFiles).toEqual(["project.ts"]);
	});

	it("degrades a malformed global file to built-in defaults", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("ignoring invalid LSP config"),
		);
	});

	it("does not leak a token from a malformed config into the warning (#2431)", async () => {
		// The literal shape from #2431's evidence: Node's own JSON.parse
		// SyntaxError embeds a slice of the source text, so an unquoted value
		// next to a real-shaped credential leaked straight through as `reason`
		// before this fix.
		const TOKEN = `ghp_${"A".repeat(36)}`;
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), `{"piToken": ${TOKEN}}`);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).toHaveBeenCalledTimes(1);
		const [message] = error.mock.calls[0];
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain("ghp_");

		const { getDegradationSummary } =
			await import("../../../clients/degradation-ledger.js");
		const group = getDegradationSummary().find(
			(g) => g.kind === "config-ignored",
		);
		const globalConfigPath = path.join(globalDir, "lsp.json");
		const ledgerEntry = group?.latestReasons.find(
			(entry) => entry.subject === globalConfigPath,
		);
		expect(ledgerEntry).toBeDefined();
		expect(ledgerEntry?.reason).not.toContain(TOKEN);
		expect(ledgerEntry?.reason).not.toContain("ghp_");
	});

	it("warns once per broken file, and again after the latch is reset", async () => {
		// The seam S3 asks for, exercised rather than merely exported: the same
		// path read twice nags once, and a caller that explicitly re-arms the
		// latch (a new session's test, or this file's own afterEach) sees it
		// again. Nothing here relies on the fixture path being unique.
		const projectDir = tmpDir("pi-lens-lsp-project-");
		const globalDir = tmpDir("pi-lens-lsp-global-");
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(path.join(globalDir, "lsp.json"), "{ invalid");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig, resetLSPConfigWarnCache } =
			await import("../../../clients/lsp/config.js");
		resetLSPConfigWarnCache();
		await loadLSPConfig(projectDir);
		await loadLSPConfig(projectDir);
		expect(error).toHaveBeenCalledTimes(1);

		resetLSPConfigWarnCache();
		await loadLSPConfig(projectDir);
		expect(error).toHaveBeenCalledTimes(2);
	});

	it("treats a missing global file as a silent no-op", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-");
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(loadLSPConfig(projectDir)).resolves.toEqual({});
		expect(error).not.toHaveBeenCalled();
	});
});

/**
 * #2426, at the public loader rather than at the resolver seam.
 *
 * Both cases below are RED on pre-#2426 `loadLSPConfig`: the walk ran to the
 * filesystem root with no `$HOME` stop, and the candidate list took the first
 * hit, which put a deprecated location ahead of the canonical one.
 */
describe("loadLSPConfig walk confinement and canonical precedence (#2426)", () => {
	it("does not adopt a legacy LSP config from at or above HOME", async () => {
		// Cross-form paths per the read-guard path-key rule: the ceiling is
		// supplied in `/` form and the cwd in native form, so a ceiling that only
		// holds when both were spelled the same way does not pass here.
		const root = tmpDir("pi-lens-lsp-ceiling-");
		const home = path.join(root, "home");
		const projectDir = path.join(home, "proj", "src");
		fs.mkdirSync(projectDir, { recursive: true });
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");

		// Above HOME.
		fs.mkdirSync(path.join(root, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".pi-lens", "lsp.json"),
			JSON.stringify({ warmFiles: ["from-above-home"] }),
		);
		// And IN HOME, which is equally off limits.
		fs.writeFileSync(
			path.join(home, "pi-lsp.json"),
			JSON.stringify({ warmFiles: ["from-home"] }),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		await expect(
			loadLSPConfig(projectDir, home.replace(/\\/g, "/")),
		).resolves.toEqual({});

		// Mutation guard: the same fixture with a config BELOW the ceiling is
		// still read, so the two assertions above cannot pass by reading nothing.
		fs.writeFileSync(
			path.join(home, "proj", ".pi-lens.json"),
			JSON.stringify({ lsp: { warmFiles: ["from-project"] } }),
		);
		await expect(
			loadLSPConfig(projectDir, home.replace(/\\/g, "/")),
		).resolves.toEqual({ warmFiles: ["from-project"] });
	});

	it("lets the canonical .pi-lens.json beat a leftover .pi-lens/lsp.json", async () => {
		const root = tmpDir("pi-lens-lsp-canonical-");
		const home = path.join(root, "home");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(path.join(projectDir, ".pi-lens"), { recursive: true });
		process.env.PI_LENS_HOME = tmpDir("pi-lens-lsp-global-");

		fs.writeFileSync(
			path.join(projectDir, ".pi-lens", "lsp.json"),
			JSON.stringify({ warmFiles: ["legacy"], disabledServers: ["typos"] }),
		);
		fs.writeFileSync(
			path.join(projectDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { warmFiles: ["canonical"] } }),
		);

		const { loadLSPConfig } = await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(projectDir, home);
		expect(config.warmFiles).toEqual(["canonical"]);
		// The legacy file is still READ — deprecation, not removal — so a key the
		// user has not migrated yet keeps working.
		expect(config.disabledServers).toEqual(["typos"]);
	});
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `initLSPConfig`'s in-flight map cleared with a bare delete-by-key. The race
 * needs a SECOND WRITER replacing the map entry mid-flight — the public API
 * alone cannot produce it today (single set site; microtask FIFO orders every
 * observer after A's cleanup) — so this test simulates that writer directly.
 * `initLSPConfig` registers the map entry synchronously (before its first
 * internal `await loadLSPConfig(cwd)` settles), so the successor can be
 * installed with zero awaits between the call and the injection. Red on the
 * pre-fix bare `.finally` delete: A's cleanup evicted B and the third caller
 * started a duplicate config load.
 */
describe("initLSPConfig in-flight ABA release (#1968)", () => {
	it("a late-settling init does not evict its mid-flight successor", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-aba-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const buildA = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, before A's
		// `await loadLSPConfig(cwd)` has had a chance to resolve.
		const inFlight = _peekConfigInFlightForTests();
		expect(inFlight.size).toBe(1);
		const key = [...inFlight.keys()][0]!;

		// B replaces the entry under the same key while A is still in flight.
		let resolveSuccessor: () => void;
		const successor = new Promise<void>((resolve) => {
			resolveSuccessor = resolve;
		});
		inFlight.set(key, successor);

		await buildA; // A settles

		// B's entry survived A's cleanup.
		expect(inFlight.get(key)).toBe(successor);

		resolveSuccessor!();
		await successor;
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here. Checked by KEY, not
	// overall map size — the sibling test above leaves a synthetic successor
	// entry under its OWN key that nothing but a real `initLSPConfig` call for
	// that same cwd would ever clear.
	it("a normally-settling init still cleans up its own entry", async () => {
		const projectDir = tmpDir("pi-lens-lsp-project-clean-");
		const { initLSPConfig, _peekConfigInFlightForTests } =
			await import("../../../clients/lsp/config.js");

		const inFlight = _peekConfigInFlightForTests();
		const before = new Set(inFlight.keys());
		const pass = initLSPConfig(projectDir);
		// Synchronous: the map entry is already registered here, exactly as the
		// ABA test above relies on.
		const key = [...inFlight.keys()].find((k) => !before.has(k))!;
		expect(key).toBeDefined();

		await pass;
		expect(inFlight.has(key)).toBe(false);
	});
});
