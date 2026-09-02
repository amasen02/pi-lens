import { describe, expect, it } from "vitest";
import {
	isRepoTier,
	provenanceFor,
	provenanceView,
	SOURCE_TIERS,
	TIER_CLASS,
	tierPrecedence,
} from "../../../clients/config-core/provenance.js";
import { resolveConfig } from "../../../clients/config-core/index.js";
import {
	DEMO_CONFIG_SCHEMA,
	GOLDEN_SOURCES,
} from "../../support/config-core-fixtures.js";

describe("the tier vocabulary is one ordering plus one classification (#2425)", () => {
	it("orders precedence lowest-first with no duplicates", () => {
		const ranks = SOURCE_TIERS.map(tierPrecedence);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(new Set(ranks).size).toBe(SOURCE_TIERS.length);
	});

	it("classifies exactly the two checkout-supplied tiers as repo content", () => {
		expect(SOURCE_TIERS.filter(isRepoTier)).toEqual([
			"project",
			"nested-project",
		]);
		expect(Object.keys(TIER_CLASS).sort()).toEqual([...SOURCE_TIERS].sort());
	});
});

describe("provenanceView is redacted by construction (#2415 AC 4)", () => {
	const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
	const { resolved } = resolveConfig({
		schema: DEMO_CONFIG_SCHEMA,
		sources: [
			...GOLDEN_SOURCES,
			{
				tier: "cli",
				value: {
					lsp: {
						servers: [{ id: "pyright", command: `pyright --token=${secret}` }],
					},
				},
			},
		],
	});

	it("projects sources, never values", () => {
		const view = provenanceView(resolved);
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain(secret);
		// The resolved value DOES carry the command, so the projection is what
		// makes the difference rather than the input being harmless.
		expect(JSON.stringify(resolved.value)).toContain(secret);
	});

	it("names every field it describes and carries only source metadata", () => {
		const view = provenanceView(resolved);
		expect(view.entries.length).toBeGreaterThan(10);
		for (const entry of view.entries) {
			expect(Object.keys(entry).sort()).toEqual(
				expect.arrayContaining(["key", "tier"]),
			);
			expect(
				Object.keys(entry).every((name) =>
					["key", "tier", "file", "trust"].includes(name),
				),
			).toBe(true);
		}
	});

	it("sorts entries by key so two runs render identically", () => {
		const keys = provenanceView(resolved).entries.map((entry) => entry.key);
		expect(keys).toEqual([...keys].sort());
	});
});

describe("provenanceFor answers at every depth (#2425)", () => {
	const resolved = resolveConfig({
		schema: DEMO_CONFIG_SCHEMA,
		sources: GOLDEN_SOURCES,
	}).resolved;

	it("returns a leaf's own entry when it has one", () => {
		expect(provenanceFor(resolved, "/lsp/servers/0/command")?.tier).toBe(
			"global",
		);
	});

	it("falls back to the nearest ancestor for a replace-merged array member", () => {
		// `warmFiles` is `replace`, so the array carries one entry and its
		// members inherit it. Every element genuinely has the same answer.
		expect(resolved.provenance.has("/lsp/warmFiles/0")).toBe(false);
		expect(provenanceFor(resolved, "/lsp/warmFiles/0")?.tier).toBe("project");
	});

	it("returns undefined for a pointer nothing describes", () => {
		expect(provenanceFor(resolved, "/nothing/here")).toBeUndefined();
	});
});
