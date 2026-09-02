/**
 * #2439 — oxlint was a devDependency with no npm script and no CI job, so an
 * undefined identifier (a `ReferenceError` at runtime) in a `scripts/*.mjs`
 * file passed `npm run lint` (tsc over the TS project only) and CI. That bug
 * shipped in scripts/prune-agent-worktrees.mjs and was only caught by running
 * the CLI by hand (#2435).
 *
 * These tests spawn the REAL `npm run lint:js` — oxlint via the shipped
 * `node_modules/oxlint/bin/oxlint` entry, against the repo's own committed
 * `.oxlintrc.json` — so a regression in either the npm script wiring or the
 * config's `no-undef` override fails here, not just in someone's manual
 * dogfood run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const OXLINT_ENTRY = path.join(REPO_ROOT, "node_modules/oxlint/bin/oxlint");
const OXLINT_CONFIG = path.join(REPO_ROOT, ".oxlintrc.json");

function runOxlint(targetFile: string) {
	return spawnSync(
		process.execPath,
		[OXLINT_ENTRY, "--config", OXLINT_CONFIG, "-f", "unix", targetFile],
		{ encoding: "utf8" },
	);
}

describe("lint:js (#2439 — oxlint wired over .mjs/.cjs)", () => {
	it("package.json wires lint:js into npm run lint", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["lint:js"]).toMatch(/^oxlint\b/);
		expect(pkg.scripts.lint).toMatch(/npm run lint:js/);
	});

	it("fails on an undefined identifier in a .mjs file (the #2435 shape)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "broken.mjs");
			fs.writeFileSync(
				fixture,
				"export function broken() {\n  return someUndefinedThing + 1;\n}\n",
			);
			const result = runOxlint(fixture);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain("no-undef");
			expect(result.stdout).toContain("someUndefinedThing");
		} finally {
			cleanup();
		}
	});

	it("does not false-positive on Node globals (env: node is wired)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "clean.mjs");
			fs.writeFileSync(
				fixture,
				"export function greet() {\n  console.log(process.argv[2] ?? 'hi');\n}\n",
			);
			const result = runOxlint(fixture);
			expect(result.status).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("stays off for .ts files (no-undef risks TS ambient-type false positives)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-lint-js-2439-");
		try {
			const fixture = path.join(tmpDir, "broken.ts");
			fs.writeFileSync(
				fixture,
				"export function broken(): number {\n  return someUndefinedThing + 1;\n}\n",
			);
			const result = runOxlint(fixture);
			// tsc (not oxlint's no-undef) is the source of truth for TS files —
			// asserted separately by `npm run lint`'s tsc step.
			expect(result.status).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("the repo's own scripts/**/*.mjs and root *.mjs currently pass clean", () => {
		const result = spawnSync(
			process.execPath,
			[
				OXLINT_ENTRY,
				"--ignore-pattern",
				"tests/fixtures/**",
				"--ignore-pattern",
				"**/*.ts",
				"--ignore-pattern",
				"**/*.tsx",
				"--ignore-pattern",
				"**/*.d.mts",
				"-f",
				"unix",
				".",
			],
			{ encoding: "utf8", cwd: REPO_ROOT },
		);
		expect(result.status, result.stdout + result.stderr).toBe(0);
	});
});
