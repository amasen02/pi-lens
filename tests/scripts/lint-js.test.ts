/**
 * #2439 — oxlint was a devDependency with no npm script and no CI job, so an
 * undefined identifier (a `ReferenceError` at runtime) in a `scripts/*.mjs`
 * file passed `npm run lint` (tsc over the TS project only) and CI. That bug
 * shipped in scripts/prune-agent-worktrees.mjs and was only caught by running
 * the CLI by hand (#2435).
 *
 * These tests spawn the REAL shipped oxlint binary (resolved via Node module
 * resolution, not a hard-coded path) against the repo's own committed
 * `.oxlintrc.json`, and the real `npm run lint:js` script itself (case 5 —
 * read from `package.json`, not a hand-rolled copy of its argv) — so a
 * regression in the npm script wiring, the config's `no-undef` override, or
 * a missing `--deny-warnings` fails here, not just in someone's manual
 * dogfood run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
// Resolved via Node's own module resolution (not a hard-coded
// `<root>/node_modules/oxlint/bin/oxlint` path) so this still finds the
// shipped binary in a worktree where oxlint is hoisted to a parent
// `node_modules` rather than living directly under REPO_ROOT.
const require = createRequire(import.meta.url);
const OXLINT_ENTRY = path.join(
	path.dirname(require.resolve("oxlint/package.json")),
	"bin",
	"oxlint",
);
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

	it("`npm run lint:js` — the repo's real self-lint scope — currently passes clean", () => {
		// Spawns the REAL `npm run lint:js` (package.json's own script, not a
		// hand-rolled copy of its ignore-pattern argv) so a drift between this
		// pin and the actual wiring fails here, not just in CI. `--deny-warnings`
		// is baked into the script itself, so a warning-only regression (the
		// #2452 review-round-1 gap — 19 baseline hits exited 0 pre-fix) reds
		// this case too, not just errors.
		const result = spawnSync(NPM, ["run", "lint:js"], {
			encoding: "utf8",
			cwd: REPO_ROOT,
			shell: IS_WIN,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	});
});
