import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type ConfigDiagnosticCode,
	DEPRECATED_CONFIG_SURFACES,
	isConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import {
	GLOBAL_LSP_CONFIG_BASENAME,
	LSP_CONFIG_PATHS,
} from "../../clients/lsp/config.js";
import { PROJECT_CONFIG_BASENAMES } from "../../clients/project-lens-config.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function parseSemver(version: string): [number, number, number] {
	const matched = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!matched) throw new Error(`not a semver: ${version}`);
	return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

function compareSemver(a: string, b: string): number {
	const left = parseSemver(a);
	const right = parseSemver(b);
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}

const PACKAGE_VERSION = (
	JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
	) as { version: string }
).version;

/**
 * The union of every Changelog `Deprecated` section: the released ones in
 * `CHANGELOG.md` plus the not-yet-rolled-up `.changelog/` fragments that
 * declare `section: Deprecated`. A row must be announced in one of them —
 * #2418 policy point 4 makes the announcement data, not etiquette.
 */
function deprecatedChangelogText(): string {
	const parts: string[] = [];

	const changelog = fs.readFileSync(
		path.join(REPO_ROOT, "CHANGELOG.md"),
		"utf-8",
	);
	const lines = changelog.split(/\r?\n/);
	let inside = false;
	for (const line of lines) {
		if (/^#{2,4}\s/.test(line)) {
			inside = /^###\s+Deprecated\s*$/.test(line);
			continue;
		}
		if (inside) parts.push(line);
	}

	const fragmentDir = path.join(REPO_ROOT, ".changelog");
	for (const name of fs.readdirSync(fragmentDir)) {
		if (!name.endsWith(".md") || name === "README.md") continue;
		const fragment = fs.readFileSync(path.join(fragmentDir, name), "utf-8");
		if (/^---[\s\S]*?section:\s*Deprecated[\s\S]*?---/m.test(fragment)) {
			parts.push(fragment);
		}
	}

	return parts.join("\n");
}

const LSP_CONFIG_SOURCE = fs.readFileSync(
	path.join(REPO_ROOT, "clients", "lsp", "config.ts"),
	"utf-8",
);

/** The body of `export interface LSPConfig { ... }`. */
function lspConfigInterfaceBody(): string {
	const start = LSP_CONFIG_SOURCE.indexOf("export interface LSPConfig {");
	expect(start).toBeGreaterThan(-1);
	const end = LSP_CONFIG_SOURCE.indexOf("\n}", start);
	return LSP_CONFIG_SOURCE.slice(start, end);
}

const KNOWN_CONFIG_FILES = new Set<string>([
	...LSP_CONFIG_PATHS,
	...PROJECT_CONFIG_BASENAMES,
	`~/.pi-lens/${GLOBAL_LSP_CONFIG_BASENAME}`,
]);

describe("deprecated config surface registry (#2418)", () => {
	it("is non-empty", () => {
		// Declared floor: an emptied registry must FAIL rather than read as
		// "nothing is deprecated". Nine rows exist today; the floor sits below
		// that so a legitimate removal at a major does not break the sweep.
		assertNonEmptyScan(
			"deprecated config surface registry",
			DEPRECATED_CONFIG_SURFACES.length,
			4,
		);
	});

	it("names each surface once per kind", () => {
		const keys = DEPRECATED_CONFIG_SURFACES.map(
			(row) => `${row.kind}:${row.surface}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("carries a semver-sane deprecation window on every row", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.deprecatedSince, row.surface).toMatch(/^\d+\.\d+\.\d+$/);
			expect(row.removeNotBefore, row.surface).toMatch(/^\d+\.\d+\.\d+$/);
			const since = parseSemver(row.deprecatedSince);
			const remove = parseSemver(row.removeNotBefore);
			// Removal happens only in a MAJOR, and only a later one.
			expect(remove[0], row.surface).toBeGreaterThan(since[0]);
			expect([remove[1], remove[2]], row.surface).toEqual([0, 0]);
		}
	});

	it("never claims a deprecation from the future", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(
				compareSemver(row.deprecatedSince, PACKAGE_VERSION),
				`${row.surface} deprecatedSince ${row.deprecatedSince} > ${PACKAGE_VERSION}`,
			).toBeLessThanOrEqual(0);
		}
	});

	it("points every row at a registered diagnostic code", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(isConfigDiagnosticCode(row.code), row.surface).toBe(true);
		}
	});

	it("uses the kind-appropriate code", () => {
		const expected: Record<"key" | "file", ConfigDiagnosticCode> = {
			key: "PILENS_CFG_0002",
			file: "PILENS_CFG_0003",
		};
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.code, row.surface).toBe(expected[row.kind]);
		}
	});

	it("gives every row a non-empty reason", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.reason.length, row.surface).toBeGreaterThan(20);
		}
	});

	it("announces every row in a Changelog Deprecated section", () => {
		const announced = deprecatedChangelogText();
		expect(announced.trim().length).toBeGreaterThan(0);
		const missing = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => !announced.includes(row.surface),
		).map((row) => row.surface);
		expect(missing).toEqual([]);
	});

	it("only deprecates FILE locations the loaders actually read", () => {
		const unknown = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => row.kind === "file" && !KNOWN_CONFIG_FILES.has(row.surface),
		).map((row) => row.surface);
		expect(unknown).toEqual([]);
	});

	it("only deprecates KEYS the LSPConfig interface declares", () => {
		const body = lspConfigInterfaceBody();
		const unknown = DEPRECATED_CONFIG_SURFACES.filter(
			(row) =>
				row.kind === "key" &&
				!new RegExp(`\\n\\s*${row.surface}\\??\\s*:`).test(body),
		).map((row) => row.surface);
		expect(unknown).toEqual([]);
	});
});
