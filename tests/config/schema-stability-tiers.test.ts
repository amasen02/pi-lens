import { describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	CONFIG_SCHEMA_ID,
	STABILITY_TIER_KEY,
} from "../../clients/config-diagnostic-codes.js";
import {
	assertSchemaIdentityAnchor,
	assertSchemaStabilityTiers,
	type JsonSchemaNode,
	PLACEHOLDER_CONFIG_SCHEMA,
} from "../support/schema-stability.js";

/**
 * #2418 policy point 1 + 3, enforced as a harness rather than against a
 * schema that does not exist yet. #2416 ships the first real catalog schema
 * and asserts it with these same two functions; if the harness itself is
 * inert, that drift test is inert too — so the mutants below are the load
 * bearing half of this file.
 */

function clone(schema: JsonSchemaNode): JsonSchemaNode {
	return structuredClone(schema);
}

describe("schema stability tiers (#2418)", () => {
	it("accepts a schema whose every property carries a valid tier", () => {
		expect(() =>
			assertSchemaStabilityTiers(PLACEHOLDER_CONFIG_SCHEMA),
		).not.toThrow();
	});

	it("fails a top-level property with no tier", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		delete properties.lsp[STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/missing x-stability/,
		);
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp/);
	});

	it("fails a NESTED property with no tier", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		const servers = (
			properties.lsp.properties as Record<string, JsonSchemaNode>
		).servers;
		delete servers[STABILITY_TIER_KEY];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(/\/lsp\/servers/);
	});

	it("fails a property reached only through items[]", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		const servers = (
			properties.lsp.properties as Record<string, JsonSchemaNode>
		).servers;
		const items = servers.items as JsonSchemaNode;
		delete (items.properties as Record<string, JsonSchemaNode>).id[
			STABILITY_TIER_KEY
		];
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/\/lsp\/servers\/items\/id/,
		);
	});

	it("fails an unknown tier value", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		properties.lsp[STABILITY_TIER_KEY] = "beta";
		expect(() => assertSchemaStabilityTiers(mutant)).toThrow(
			/invalid x-stability/,
		);
	});

	it("accepts both tiers in the closed vocabulary", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		const properties = mutant.properties as Record<string, JsonSchemaNode>;
		properties.lsp[STABILITY_TIER_KEY] = "stable";
		expect(() => assertSchemaStabilityTiers(mutant)).not.toThrow();
	});
});

describe("config envelope identity anchor (#2418)", () => {
	it("accepts the reserved anchor", () => {
		expect(() =>
			assertSchemaIdentityAnchor(PLACEHOLDER_CONFIG_SCHEMA),
		).not.toThrow();
		expect(PLACEHOLDER_CONFIG_SCHEMA.$id).toBe(CONFIG_SCHEMA_ID);
	});

	it("fails a drifted $id", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		mutant.$id = "https://example.invalid/other.json";
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(/\$id must be/);
	});

	it("fails a missing meta-schema declaration", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		delete mutant.$schema;
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(/meta-schema/);
	});

	it("fails when the root drops the $schema instance property", () => {
		const mutant = clone(PLACEHOLDER_CONFIG_SCHEMA);
		delete (mutant.properties as Record<string, JsonSchemaNode>)[
			CONFIG_SCHEMA_ANCHOR_KEY
		];
		expect(() => assertSchemaIdentityAnchor(mutant)).toThrow(
			/instance property/,
		);
	});
});
