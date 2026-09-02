/**
 * Shared assertions for the published-schema half of the #2418 stability
 * policy, exported so #2416's first real catalog schema reuses THIS harness
 * instead of hand-rolling a second walker.
 *
 * Deliberately NOT a schema: no catalog shape is invented here. The fixture
 * below exists only so the harness's own positive/negative behavior is proven
 * before any real schema exists to run it against.
 */

import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	CONFIG_SCHEMA_ID,
	isStabilityTier,
	STABILITY_TIER_KEY,
} from "../../clients/config-diagnostic-codes.js";

export type JsonSchemaNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonSchemaNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keywords whose value is an OBJECT of named subschemas that ARE published
 * properties — each one must carry a tier. `patternProperties` counts: a field
 * matched by a regex is still a field a user writes.
 */
const NAMED_PROPERTY_CONTAINERS = ["properties", "patternProperties"] as const;

/**
 * Keywords whose value is an OBJECT of named subschemas that are NOT
 * themselves properties — a `$defs` entry is a reusable shape, not a field, so
 * it needs no tier. Every property INSIDE one still does, which is exactly why
 * the walk has to descend into them: `$defs` is the easiest place for an
 * untiered field to hide.
 */
const NAMED_SUBSCHEMA_CONTAINERS = ["$defs", "definitions"] as const;

/** Keywords whose value is an ARRAY of subschemas. */
const SUBSCHEMA_LISTS = ["oneOf", "anyOf", "allOf", "prefixItems"] as const;

/**
 * Keywords whose value is a SINGLE subschema. `additionalProperties`,
 * `items` and friends are also legal as booleans (`additionalProperties:
 * false`) — the object guard below skips those, since a boolean has no
 * properties to tier.
 */
const SUBSCHEMA_VALUES = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
] as const;

/**
 * Every published property carries a valid `x-stability` tier.
 *
 * Walks every subschema-bearing keyword, not just `properties`/`items`: a
 * schema can put a field under `oneOf`, `$defs`, `additionalProperties`,
 * `prefixItems`, `not`, or `if`/`then`/`else` and it is no less published for
 * it. A walker that only knew two keywords would pass a schema whose entire
 * catalog lived in a `$defs` block — an enforcement test that cannot see the
 * shape it governs is worse than none, because it reads as coverage.
 *
 * The ROOT node is not itself a property, so it is exempt; every named property
 * below it is not. Throws with the JSON-pointer-ish path of every offender, so
 * a CI failure names the field rather than the schema.
 */
export function assertSchemaStabilityTiers(schema: unknown): void {
	if (!isObject(schema)) {
		throw new Error("schema must be an object");
	}
	const untiered: string[] = [];
	const badTier: string[] = [];
	// Shared subschema objects (and `$ref`-free self-references built by hand)
	// would otherwise recurse forever; the walk is a graph walk, not a tree walk.
	const seen = new Set<JsonSchemaNode>();

	const walk = (node: unknown, pathParts: string[]): void => {
		if (!isObject(node) || seen.has(node)) return;
		seen.add(node);

		for (const container of NAMED_PROPERTY_CONTAINERS) {
			const properties = node[container];
			if (!isObject(properties)) continue;
			for (const [name, child] of Object.entries(properties)) {
				const childPath = [...pathParts, name];
				const pointer = `/${childPath.join("/")}`;
				if (!isObject(child)) {
					untiered.push(pointer);
					continue;
				}
				const tier = child[STABILITY_TIER_KEY];
				if (tier === undefined) untiered.push(pointer);
				else if (!isStabilityTier(tier))
					badTier.push(`${pointer} (${String(tier)})`);
				walk(child, childPath);
			}
		}

		for (const container of NAMED_SUBSCHEMA_CONTAINERS) {
			const definitions = node[container];
			if (!isObject(definitions)) continue;
			for (const [name, child] of Object.entries(definitions)) {
				walk(child, [...pathParts, container, name]);
			}
		}

		for (const keyword of SUBSCHEMA_LISTS) {
			const branches = node[keyword];
			if (!Array.isArray(branches)) continue;
			branches.forEach((branch, index) =>
				walk(branch, [...pathParts, keyword, `${index}`]),
			);
		}

		for (const keyword of SUBSCHEMA_VALUES) {
			const value = node[keyword];
			if (Array.isArray(value)) {
				// Draft-07 tuple form of `items`.
				value.forEach((entry, index) =>
					walk(entry, [...pathParts, keyword, `${index}`]),
				);
			} else if (isObject(value)) {
				walk(value, [...pathParts, keyword]);
			}
		}
	};

	walk(schema, []);

	const failures = [
		untiered.length > 0
			? `missing ${STABILITY_TIER_KEY}: ${untiered.join(", ")}`
			: "",
		badTier.length > 0
			? `invalid ${STABILITY_TIER_KEY}: ${badTier.join(", ")}`
			: "",
	].filter(Boolean);
	if (failures.length > 0) {
		throw new Error(`schema stability tiers: ${failures.join("; ")}`);
	}
}

/**
 * The published schema carries the reserved config-envelope identity anchor:
 * its own `$id` is `CONFIG_SCHEMA_ID`, it declares a JSON Schema meta-schema,
 * and the ROOT declares a `$schema` INSTANCE property so a user's config file
 * can name the schema it was written against (#2418 policy point 3).
 */
export function assertSchemaIdentityAnchor(schema: unknown): void {
	if (!isObject(schema)) {
		throw new Error("schema must be an object");
	}
	if (schema.$id !== CONFIG_SCHEMA_ID) {
		throw new Error(
			`schema $id must be ${CONFIG_SCHEMA_ID}, got ${String(schema.$id)}`,
		);
	}
	if (typeof schema.$schema !== "string" || schema.$schema.length === 0) {
		throw new Error("schema must declare a $schema meta-schema");
	}
	const properties = schema.properties;
	if (
		!isObject(properties) ||
		!isObject(properties[CONFIG_SCHEMA_ANCHOR_KEY])
	) {
		throw new Error(
			`schema root must declare a "${CONFIG_SCHEMA_ANCHOR_KEY}" instance property`,
		);
	}
}

/**
 * Minimal well-formed fixture: a placeholder envelope, NOT the catalog schema.
 * #2416 replaces the object it is asserted against, not this harness.
 */
export const PLACEHOLDER_CONFIG_SCHEMA: JsonSchemaNode = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: CONFIG_SCHEMA_ID,
	type: "object",
	properties: {
		[CONFIG_SCHEMA_ANCHOR_KEY]: {
			type: "string",
			description: "Identity anchor naming the schema this config follows.",
			[STABILITY_TIER_KEY]: "stable",
		},
		lsp: {
			type: "object",
			[STABILITY_TIER_KEY]: "experimental",
			properties: {
				servers: {
					type: "array",
					[STABILITY_TIER_KEY]: "experimental",
					items: {
						type: "object",
						properties: {
							id: { type: "string", [STABILITY_TIER_KEY]: "stable" },
						},
					},
				},
			},
		},
	},
};
