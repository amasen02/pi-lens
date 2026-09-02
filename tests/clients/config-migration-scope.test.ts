/**
 * WHICH keys get migration advice, WHO reports a config notice, and how many
 * notices one bad file can produce (#2426 review round 4).
 *
 * Five defects, one surface — the notices a user actually reads:
 *
 * F1. `~/.pi-lens/config.json` carrying a legacy ROOT LSP key had its value
 *     APPLIED by the LSP loader and simultaneously called a typo by the global
 *     loader, whose recognized-key catalog never picked up the legacy root keys.
 * F2/F5. `deprecationRecords` emitted one "move it" record per EVERY top-level
 *     key of a legacy file, recognized or not, outside the bounded collector.
 * F3. The project loader's OWN `config-ignored` warnings were not captured into
 *     the cache entry, so a warm cache HIT replayed only the deprecation half.
 * F4. The half-migrated notices were produced only by `loadLSPConfig`; under
 *     `--no-lsp` / `lsp.enabled:false` / a subagent session nobody produced them.
 * #2445. `loadPiLensGlobalConfig`'s bare `catch { return undefined }` gave a
 *     malformed global config zero signal of its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MIGRATION_RECORDS } from "../../clients/config-core/records.js";
import { resetIgnoredConfigWarnCache } from "../../clients/config-warn.js";
import { removeTempDirSync } from "./test-utils.js";

const notices: string[] = [];
const userNotices: string[] = [];
const ledgerRows: Array<{ kind: string; subject: string; reason: string }> = [];

vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => {
			notices.push(entry.message);
		},
	};
});

vi.mock("../../clients/user-notify.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/user-notify.js")>();
	return {
		...actual,
		notifyUserDegradation: (message: string) => {
			userNotices.push(message);
		},
	};
});

vi.mock("../../clients/degradation-ledger.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/degradation-ledger.js")
		>();
	return {
		...actual,
		recordDegradationOnce: (entry: {
			kind: string;
			subject: string;
			reason: string;
		}) => {
			ledgerRows.push({
				kind: entry.kind,
				subject: entry.subject,
				reason: entry.reason,
			});
		},
	};
});

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

let previousConfigPath: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
	notices.length = 0;
	userNotices.length = 0;
	ledgerRows.length = 0;
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousHome = process.env.PI_LENS_HOME;
	resetIgnoredConfigWarnCache();
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetIgnoredConfigWarnCache();
	const { resetProjectLensConfigCache } =
		await import("../../clients/project-lens-config.js");
	resetProjectLensConfigCache();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

const deprecationNotices = (): string[] =>
	notices.filter((message) => message.startsWith("deprecated "));
const ignoredNotices = (): string[] =>
	notices.filter((message) => message.startsWith("ignoring invalid "));

describe("F1: a legacy root LSP key in the GLOBAL config is a migration, not a typo", () => {
	it("gives all four legacy root keys a migration notice and no typo notice", async () => {
		const home = tmpRoot("pi-lens-f1-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		process.env.PI_LENS_CONFIG_PATH = globalFile;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		write(globalFile, {
			servers: {},
			serverOverrides: {},
			disabledServers: ["ts"],
			warmFiles: ["a.ts"],
		});

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		loadPiLensGlobalConfig(globalFile);

		// The values ARE applied by the LSP loader out of this same file, so
		// calling them typos is the contradiction under test.
		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		const lsp = await loadLSPConfig(path.join(home, "proj"), home);
		expect(lsp.disabledServers).toEqual(["ts"]);
		expect(lsp.warmFiles).toEqual(["a.ts"]);

		const typos = notices.filter((message) => message.includes("unknown key"));
		expect(typos, `typo notices: ${JSON.stringify(typos)}`).toEqual([]);
		for (const key of [
			"servers",
			"serverOverrides",
			"disabledServers",
			"warmFiles",
		]) {
			expect(
				deprecationNotices().filter((message) =>
					message.includes(`move "${key}"`),
				),
				key,
			).toHaveLength(1);
		}
	});
});

describe("F2/F5: migration advice only for keys the schema recognizes, bounded", () => {
	it("does not tell the user to move a key that is not a pi-lens setting", async () => {
		const home = tmpRoot("pi-lens-f2-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f2-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		const legacy: Record<string, unknown> = {
			ignore: ["dist/**"],
			maxProjectFiles: 500,
		};
		for (let index = 0; index < 98; index += 1) {
			legacy[`notASetting${index}`] = index;
		}
		write(path.join(projectDir, "pi-lens.json"), legacy);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const misdirected = deprecationNotices().filter((message) =>
			message.includes('move "notASetting'),
		);
		expect(
			misdirected.length,
			`migration advice for unrecognized keys: ${misdirected.length}`,
		).toBe(0);

		// A typo key still gets its typo notice — that half is correct.
		expect(
			ignoredNotices().filter((message) =>
				message.includes('unknown key "notASetting0"'),
			),
		).toHaveLength(1);
	});

	it("bounds the notices one 100-key legacy file can produce", async () => {
		const home = tmpRoot("pi-lens-f2b-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f2b-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		const legacy: Record<string, unknown> = {
			ignore: ["dist/**"],
			maxProjectFiles: 500,
		};
		for (let index = 0; index < 98; index += 1) {
			legacy[`notASetting${index}`] = index;
		}
		write(path.join(projectDir, "pi-lens.json"), legacy);

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		// TWO bounded collectors, one per class of record: the shared resolution's
		// (deprecations + core validation drops) and this loader's own unknown-key
		// scan. Each holds one slot back for the count of what it suppressed, so
		// each class is capped at MAX_MIGRATION_RECORDS however many keys the file
		// has. Pre-fix this was 198 notifications for the same file.
		const counts = `deprecated=${deprecationNotices().length} ignored=${
			ignoredNotices().length
		} total=${userNotices.length}`;
		expect(deprecationNotices().length, counts).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		expect(ignoredNotices().length, counts).toBeLessThanOrEqual(
			MAX_MIGRATION_RECORDS,
		);
		expect(userNotices.length, counts).toBeLessThanOrEqual(
			2 * MAX_MIGRATION_RECORDS,
		);

		// ONE whole-file record naming how many keys were not recognized …
		expect(
			deprecationNotices().filter((message) =>
				message.includes(
					"98 of its top-level keys are not recognized pi-lens settings",
				),
			),
			JSON.stringify(deprecationNotices()),
		).toHaveLength(1);
		// … and the suppression is COUNTED rather than silent.
		expect(
			ignoredNotices().filter((message) =>
				message.includes(
					"further ignored settings in this file were not listed",
				),
			),
		).toHaveLength(1);
	});
});

describe("F3: a warm cache HIT replays the config-ignored rows too", () => {
	it("re-records the project loader's own ignored-key rows on a cache hit", async () => {
		const home = tmpRoot("pi-lens-f3-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f3-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, ".pi-lens.json"), {
			maxProjectFile: 500,
			maxProjectFiles: "nope",
			rules: { "high-complexity": [] },
		});

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);
		const first = ledgerRows.filter((row) => row.kind === "config-ignored");
		expect(first.length, "session 1 config-ignored rows").toBeGreaterThan(0);

		// Session 2, warm: the ledger is reset at session_start, the config cache
		// is not, and `resetProjectLensConfigCache` has no production caller.
		ledgerRows.length = 0;
		loadPiLensProjectConfig(projectDir);
		const second = ledgerRows.filter((row) => row.kind === "config-ignored");
		expect(
			second.map((row) => row.reason).sort(),
			`session 2 config-ignored rows: ${JSON.stringify(second)}`,
		).toEqual(first.map((row) => row.reason).sort());
	});
});

describe("F4: the project loader alone produces the half-migrated notices", () => {
	it("reports a legacy SIBLING file without the LSP loader running", async () => {
		const home = tmpRoot("pi-lens-f4a-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f4a-global-");
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });
		write(path.join(projectDir, "pi-lens.json"), {
			ignore: ["legacy/**"],
			maxProjectFiles: 500,
		});
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["canonical/**"] });

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(projectDir);

		const forKey = (key: string): string[] =>
			deprecationNotices().filter((message) =>
				message.includes(`move "${key}" to`),
			);
		expect(forKey("ignore"), JSON.stringify(deprecationNotices())).toHaveLength(
			1,
		);
		expect(forKey("maxProjectFiles")).toHaveLength(1);
	});

	it("reports a legacy ANCESTOR file without the LSP loader running", async () => {
		const home = tmpRoot("pi-lens-f4b-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-f4b-global-");
		const root = path.join(home, "root");
		const nested = path.join(root, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		write(path.join(root, "pi-lens.json"), {
			ignore: ["root-legacy/**"],
			maxProjectFiles: 700,
		});
		write(path.join(nested, ".pi-lens.json"), { ignore: ["pkg/**"] });

		const { loadPiLensProjectConfig, resetProjectLensConfigCache } =
			await import("../../clients/project-lens-config.js");
		resetProjectLensConfigCache();
		loadPiLensProjectConfig(nested);

		const forKey = (key: string): string[] =>
			deprecationNotices().filter((message) =>
				message.includes(`move "${key}" to`),
			);
		expect(forKey("ignore"), JSON.stringify(deprecationNotices())).toHaveLength(
			1,
		);
		expect(forKey("maxProjectFiles")).toHaveLength(1);
	});
});

describe("S1: an internal resolution failure names a file and one subsystem", () => {
	/**
	 * The core's outer guard is the floor UNDER the bounds inside `validate` and
	 * `merge`, so nothing a user can write reaches it any more — the only way to
	 * exercise it is to make reading a SOURCE throw, which is what the getter
	 * below does. That is the point: the record it emits is the one a user would
	 * see if a future bug in either half fired, and it carried `file: ""` and no
	 * tier, so it rendered as `ignoring invalid LSP config : …` three times over.
	 */
	function throwingSource(file: string) {
		return {
			tier: "project" as const,
			file,
			get trust(): never {
				throw new Error("boom");
			},
			value: {},
		};
	}

	it("anchors the record to the resolution's highest-precedence source", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const { PI_LENS_CONFIG_SCHEMA } =
			await import("../../clients/config-schema.js");
		const file = path.join(tmpRoot("pi-lens-s1-"), ".pi-lens.json");

		const resolution = resolveConfig({
			sources: [throwingSource(file)],
			schema: PI_LENS_CONFIG_SCHEMA,
		});

		const failure = resolution.records.find(
			(record) => record.code === "PILENS_CFG_0005",
		);
		expect(failure, JSON.stringify(resolution.records)).toBeDefined();
		expect(failure?.file).toBe(file);
		expect(failure?.subject).toBe(file);
		expect(failure?.tier).toBe("project");
	});

	it("reports it under ONE subsystem, naming the file", async () => {
		const { resolveConfig } =
			await import("../../clients/config-core/resolve.js");
		const { PI_LENS_CONFIG_SCHEMA } =
			await import("../../clients/config-schema.js");
		const { reportPiLensConfigRecords } =
			await import("../../clients/config-resolve.js");
		const file = path.join(tmpRoot("pi-lens-s1b-"), ".pi-lens.json");

		reportPiLensConfigRecords(
			resolveConfig({
				sources: [throwingSource(file)],
				schema: PI_LENS_CONFIG_SCHEMA,
			}).records,
		);

		expect(notices, JSON.stringify(notices)).toHaveLength(1);
		expect(notices[0]).toContain("ignoring invalid project config");
		expect(notices[0]).toContain(file);
		// Never the empty-path shape `ignoring invalid LSP config : …`.
		expect(notices[0]).not.toContain("config : ");
	});
});

describe("#2445: a malformed GLOBAL config is not silent, and is not LSP's", () => {
	it("emits a lens-config notice from the global loader itself", async () => {
		const home = tmpRoot("pi-lens-2445-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		process.env.PI_LENS_CONFIG_PATH = globalFile;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		fs.mkdirSync(path.dirname(globalFile), { recursive: true });
		fs.writeFileSync(globalFile, '{ "ignore": [ ');

		const { loadPiLensGlobalConfig, resetGlobalConfigWarnCache } =
			await import("../../clients/lens-config.js");
		resetGlobalConfigWarnCache();
		expect(loadPiLensGlobalConfig(globalFile)).toBeUndefined();

		expect(
			notices,
			`notices from the global loader: ${JSON.stringify(notices)}`,
		).toHaveLength(1);
		expect(notices[0]).toContain("ignoring invalid global config");
	});

	it("does not let the LSP loader relabel a pi-lens global document as LSP", async () => {
		const home = tmpRoot("pi-lens-2445b-home-");
		const globalFile = path.join(home, ".pi-lens", "config.json");
		process.env.PI_LENS_CONFIG_PATH = globalFile;
		process.env.PI_LENS_HOME = path.join(home, ".pi-lens");
		fs.mkdirSync(path.dirname(globalFile), { recursive: true });
		fs.writeFileSync(globalFile, '{ "ignore": [ ');
		const projectDir = path.join(home, "proj");
		fs.mkdirSync(projectDir, { recursive: true });

		const { loadLSPConfig } = await import("../../clients/lsp/config.js");
		await loadLSPConfig(projectDir, home);

		const mislabelled = notices.filter(
			(message) =>
				message.includes("ignoring invalid LSP config") &&
				message.includes(globalFile),
		);
		expect(mislabelled, `mislabelled: ${JSON.stringify(notices)}`).toEqual([]);
		expect(
			notices.filter((message) =>
				message.includes("ignoring invalid global config"),
			),
		).toHaveLength(1);
	});
});
