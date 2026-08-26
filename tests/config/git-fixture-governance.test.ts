import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const directGitSpawn =
	/\b(execSync|execFileSync|spawnSync|spawn|execFile|safeSpawnAsync)\s*\(\s*["'`]git\b/g;
const helperImport =
	/import\s*{([^}]+)}\s*from\s*["'`][^"'`]*git-fixture-env/gs;

const OWN_IMPLEMENTATION_FILES = [
	"git-fixture-governance.test.ts",
	"git-fixture-env.ts",
	"git-fixture-env.mjs",
] as const;

export function findGitSpawnOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	return files
		.filter(({ file, source }) => {
			directGitSpawn.lastIndex = 0;
			if (OWN_IMPLEMENTATION_FILES.some((name) => file.endsWith(name)))
				return false;
			const imported = new Set<string>();
			for (const match of source.matchAll(helperImport)) {
				for (const item of match[1].split(","))
					imported.add(item.trim().split(/\s+as\s+/)[0] ?? "");
			}
			for (const match of source.matchAll(directGitSpawn)) {
				if (!imported.has(match[1])) return true;
			}
			return false;
		})
		.map(({ file }) => file);
}

function walkFiles(
	root: string,
	matches: (name: string) => boolean,
): Array<{ file: string; source: string }> {
	const files: Array<{ file: string; source: string }> = [];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (matches(entry.name))
				files.push({ file, source: fs.readFileSync(file, "utf8") });
		}
	}
	walk(root);
	return files;
}

function testFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".test.ts"));
}

/**
 * scripts/**\/*.mjs is a second population that can spawn a bare `git`
 * process (#2163 F7): standalone smoke/compat scripts, not vitest tests.
 * Walked separately because it lives outside tests/ and uses the .mjs
 * fixture helper (scripts/lib/git-fixture-env.mjs) rather than the .ts one.
 */
function scriptFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".mjs"));
}

describe("real Git fixture governance", () => {
	it("routes every direct Git spawn through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			testFiles(path.resolve(__dirname, "..")),
		);
		expect(
			offenders,
			`Bare Git spawns found:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("routes every direct Git spawn in scripts/**/*.mjs through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			scriptFiles(path.resolve(__dirname, "../../scripts")),
		);
		const REMAINING_OFFENDERS = [
			// #2163 F7 remainder: filed as #2177.
			"characterize-lsp.mjs",
			"server-capabilities.mjs",
			"smoke-gitleaks-scratch-exclusion.mjs",
			"smoke-tools.mjs",
		];
		const NOT_A_FIXTURE = [
			// Queries the developer's OWN real repo (git diff against the branch
			// range) to pick which tests to run. No throwaway fixture directory
			// involved, so fixture-isolation policy does not apply here.
			"pre-push-targeted-tests.mjs",
		];
		const unexpected = offenders.filter(
			(file) =>
				!REMAINING_OFFENDERS.some((name) => file.endsWith(name)) &&
				!NOT_A_FIXTURE.some((name) => file.endsWith(name)),
		);
		expect(
			unexpected,
			`Unexpected bare Git spawns found:\n${unexpected.join("\n")}`,
		).toEqual([]);
	});

	it("detects a synthetic bare Git offender", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: 'execFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a helper mention that does not import or call the helper", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: '// git-fixture-env\nexecFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a direct call when a different helper symbol is imported", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'import { gitExecSync } from "./git-fixture-env.js";\nexecFileSync("git", [])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("scans a non-empty source population", () => {
		const files = testFiles(path.resolve(__dirname, ".."));
		// Calibration: 807 *.test.ts files under tests/ on 2026-08-26 (fix round
		// 2). Half is 403.5; 400 is the documented floor so the walk still fails
		// loud if the tests/ tree collapses, without pinning to the exact count.
		assertNonEmptyScan("git fixture governance sweep", files.length, 400);
	});

	it("scans a non-empty scripts/**/*.mjs population", () => {
		const files = scriptFiles(path.resolve(__dirname, "../../scripts"));
		// Calibration: 60+ *.mjs files under scripts/ on 2026-08-26 (fix round
		// 2); 30 is a floor well below that, well above zero.
		assertNonEmptyScan(
			"git fixture governance scripts sweep",
			files.length,
			30,
		);
	});
});
