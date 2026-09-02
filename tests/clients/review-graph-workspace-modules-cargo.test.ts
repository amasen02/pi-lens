/**
 * Golden + regression coverage for the Cargo.toml reader fold (#2473).
 *
 * `clients/review-graph/workspace-modules.ts`'s `scanCargoModules`/
 * `detectWorkspaceType` used to carry their own regex TOML reader
 * (`extractTomlArray`/`extractTomlSection`/`extractTomlString`), a third
 * copy alongside `clients/cargo-manifest.ts` (#2466) and
 * `clients/lsp/server.ts`'s rust-analyzer hoisting. `extractTomlString` was
 * NOT table-scoped: it scanned the whole manifest for the first
 * `name = "..."` line regardless of table, so a member crate whose `name`
 * key appeared under some OTHER table before `[package]` (a `[[bin]]` or
 * `[package.metadata.*]` block) silently returned the wrong crate name for
 * the module graph.
 *
 * `tests/fixtures/cargo-modules-snapshot.json` is the committed "before"
 * golden — `buildModuleGraph`'s output (via `scanCargoModules`/
 * `detectWorkspaceType`, its only externally observable surface) over every
 * `Cargo.toml`-bearing fixture directory in `tests/fixtures/`, captured on
 * pre-#2473 code. Regenerate with `node scripts/gen-cargo-modules-snapshot.mjs`
 * after a change and diff it — a change to this reader should show up here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	SNAPSHOT_PATH,
} from "../../scripts/gen-cargo-modules-snapshot.mjs";
import {
	buildModuleGraph,
	clearModuleGraphCache,
} from "../../clients/review-graph/workspace-modules.js";

const SYNTHETIC_WORKSPACE = fileURLToPath(
	new URL(
		"../fixtures/cargo-workspace-modules/synthetic-workspace",
		import.meta.url,
	),
);

describe("cargo module-graph golden snapshot (#2473)", () => {
	it("matches the committed fixture", () => {
		const fixture = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		expect(buildSnapshot()).toEqual(fixture);
	});
});

describe("Cargo.toml reader table-scoping (#2473)", () => {
	it("reads a member crate's name from `[package]`, not an earlier `[[bin]]` block", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph).not.toBeNull();
		// `crates/bin-before-package/Cargo.toml` declares `[[bin]] name =
		// "wrong-bin-name"` BEFORE `[package] name = "bin-before-package"`. The
		// pre-fold unscoped reader returned the `[[bin]]` value.
		expect(graph?.modules.has("bin-before-package")).toBe(true);
		expect(graph?.modules.has("wrong-bin-name")).toBe(false);
	});

	it("reads a member crate's name from `[package]`, not an earlier `[package.metadata.*]` block", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph).not.toBeNull();
		// `crates/metadata-before-package/Cargo.toml` declares
		// `[package.metadata.docs.rs] name = "wrong-metadata-name"` BEFORE
		// `[package] name = "metadata-before-package"`.
		expect(graph?.modules.has("metadata-before-package")).toBe(true);
		expect(graph?.modules.has("wrong-metadata-name")).toBe(false);
	});

	it("still resolves an internal dependency edge and `[dependencies]` names unscoped-array-preserving", () => {
		clearModuleGraphCache();
		const graph = buildModuleGraph(SYNTHETIC_WORKSPACE);
		expect(graph?.modules.get("normal-with-deps")?.internalDeps).toEqual([
			"autofix-smoke",
		]);
		expect(graph?.modules.get("normal-with-deps")?.externalDeps.sort()).toEqual(
			["serde", "tokio"],
		);
	});
});
