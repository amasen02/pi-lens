/**
 * Field-wise merge with per-leaf provenance (#2425, scope items 2 and 3).
 *
 * The three loaders this replaces each merge differently: `lsp/config.ts`
 * spreads two objects and hand-patches four keys, `lens-config.ts` projects
 * field by field, and `project-lens-config.ts` never merges with the global
 * config at all. One merger with a per-node strategy expresses all three, and
 * — unlike any of them — it can say afterwards where each value came from.
 *
 * Rules:
 *
 * - OBJECTS ARE ALWAYS FIELD-WISE. A nearer tier that sets one key of an object
 *   does not erase the rest. This is #2415's "never whole-object replacement".
 * - ARRAYS follow the node's `x-merge-strategy`: `replace` by default, or
 *   `append`, or `keyed:<field>`.
 * - DENY-ANNOTATED NODES go to `deny.ts` instead, whatever the merge strategy
 *   says. Monotonic deny outranks precedence by construction.
 * - EVERY LEAF GETS PROVENANCE, keyed by its JSON-pointer path in the RESOLVED
 *   value, so a consumer navigates from an entry to the value it describes.
 *
 * Sources are sorted by tier precedence rather than trusted in caller order, so
 * assembling them in a different order cannot silently invert precedence. Ties
 * keep caller order, which is how several `nested-project` files stay ordered
 * from outermost to innermost.
 *
 * Pure: no state, no I/O, no ledger writes.
 */

import {
	type DenyContribution,
	denyProvenance,
	resolveArrayDeny,
	resolveBooleanDeny,
} from "./deny.js";
import type { ConfigObject } from "./schema.js";
import {
	type Provenance,
	type Resolved,
	type SourceTier,
	tierPrecedence,
	type TrustDecision,
} from "./provenance.js";
import {
	type ConfigSchemaNode,
	type ConfigValue,
	denyPolicyOf,
	isConfigObject,
	isPlainObject,
	isSchemaNode,
	itemsSchema,
	keyedField,
	type MergeStrategy,
	mergeStrategyOf,
	propertySchema,
	schemaType,
} from "./schema.js";

/** One normalized configuration and where it came from. */
export interface ConfigSource {
	readonly tier: SourceTier;
	/** The file it was read from, when there is one. */
	readonly file?: string;
	/** The trust decision that applied to that file. */
	readonly trust?: TrustDecision;
	/** The value AFTER `validate()`. Merging raw input is a type error waiting. */
	readonly value: ConfigValue | undefined;
}

/** One source's value at the node currently being merged. */
interface Contribution {
	readonly source: ConfigSource;
	readonly value: ConfigValue;
	/** Index in the precedence-sorted source list; higher wins. */
	readonly rank: number;
}

/**
 * Merge normalized sources into one resolved config with per-leaf provenance.
 *
 * Sources whose value is `undefined` contribute nothing — that is how a config
 * file that failed validation drops out without a special case.
 */
export function merge<T = unknown>(
	sources: readonly ConfigSource[],
	schema: ConfigSchemaNode,
): Resolved<T> {
	const ordered = [...sources]
		.map((source, order) => ({ source, order }))
		.sort((left, right) => {
			const byTier =
				tierPrecedence(left.source.tier) - tierPrecedence(right.source.tier);
			return byTier !== 0 ? byTier : left.order - right.order;
		})
		.map((entry, rank) => ({ source: entry.source, rank }));

	const contributions: Contribution[] = [];
	for (const entry of ordered) {
		// A source whose value is `undefined` contributes nothing. Filtering with
		// a narrowing loop rather than `.filter()` keeps the element type exact:
		// `Array.filter` cannot drop `undefined` from the value's type on its own.
		const value = entry.source.value;
		if (value === undefined) continue;
		contributions.push({ source: entry.source, value, rank: entry.rank });
	}

	const provenance = new Map<string, Provenance>();
	const value = mergeNode(contributions, schema, "", provenance);
	return { value: value as T, provenance };
}

function provenanceOf(contribution: Contribution, key: string): Provenance {
	const { source } = contribution;
	return {
		tier: source.tier,
		key,
		...(source.file === undefined ? {} : { file: source.file }),
		...(source.trust === undefined ? {} : { trust: source.trust }),
	};
}

function stamp(
	provenance: Map<string, Provenance>,
	contribution: Contribution,
	key: string,
): void {
	provenance.set(key, provenanceOf(contribution, key));
}

function mergeNode(
	contributions: readonly Contribution[],
	schema: ConfigSchemaNode | undefined,
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue | undefined {
	if (contributions.length === 0) return undefined;

	const denyPolicy = denyPolicyOf(schema);
	if (denyPolicy) return mergeDeny(contributions, denyPolicy, key, provenance);

	if (isObjectNode(schema, contributions)) {
		return mergeObject(contributions, schema, key, provenance);
	}
	if (isArrayNode(schema, contributions)) {
		return mergeArray(contributions, schema, key, provenance);
	}

	const winner = contributions[contributions.length - 1];
	stamp(provenance, winner, key);
	return winner.value;
}

/**
 * An object node: either the schema says so, or every contribution IS a plain
 * object. The second arm matters because a schema may be opaque about a
 * sub-object, and merging two objects whole would drop the field-wise rule the
 * moment a schema is incomplete.
 */
function isObjectNode(
	schema: ConfigSchemaNode | undefined,
	contributions: readonly Contribution[],
): boolean {
	const declared = schemaType(schema);
	if (declared === "object") return true;
	if (declared !== undefined) return false;
	if (schema && isSchemaNode(schema.properties)) return true;
	return contributions.every((entry) => isPlainObject(entry.value));
}

function isArrayNode(
	schema: ConfigSchemaNode | undefined,
	contributions: readonly Contribution[],
): boolean {
	const declared = schemaType(schema);
	if (declared === "array") return true;
	if (declared !== undefined) return false;
	return contributions.every((entry) => Array.isArray(entry.value));
}

function mergeDeny(
	contributions: readonly Contribution[],
	policy: "boolean-false" | "array-union",
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue | undefined {
	const denyContributions: DenyContribution[] = contributions.map((entry) => ({
		tier: entry.source.tier,
		value: entry.value,
		...(entry.source.file === undefined ? {} : { file: entry.source.file }),
		...(entry.source.trust === undefined ? {} : { trust: entry.source.trust }),
	}));
	const resolution =
		policy === "boolean-false"
			? resolveBooleanDeny(denyContributions)
			: resolveArrayDeny(denyContributions);
	const entry = denyProvenance(denyContributions, resolution, key);
	if (entry) provenance.set(key, entry);
	return resolution.value;
}

function mergeObject(
	contributions: readonly Contribution[],
	schema: ConfigSchemaNode | undefined,
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue | undefined {
	const objects = contributions.filter((entry) => isConfigObject(entry.value));
	if (objects.length === 0) {
		const winner = contributions[contributions.length - 1];
		stamp(provenance, winner, key);
		return winner.value;
	}

	// Field order: lowest tier's keys first, each nearer tier appending only the
	// keys it introduces. A resolved config therefore reads in the order the
	// user's own files introduced things.
	const names: string[] = [];
	for (const entry of objects) {
		for (const name of Object.keys(entry.value as ConfigObject)) {
			if (!names.includes(name)) names.push(name);
		}
	}

	const out: ConfigObject = {};
	for (const name of names) {
		const childKey = `${key}/${name}`;
		const childContributions: Contribution[] = [];
		for (const entry of objects) {
			const parent = entry.value as ConfigObject;
			if (!Object.hasOwn(parent, name)) continue;
			childContributions.push({
				source: entry.source,
				value: parent[name],
				rank: entry.rank,
			});
		}
		const merged = mergeNode(
			childContributions,
			propertySchema(schema, name),
			childKey,
			provenance,
		);
		if (merged !== undefined) out[name] = merged;
	}
	return out;
}

function mergeArray(
	contributions: readonly Contribution[],
	schema: ConfigSchemaNode | undefined,
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue | undefined {
	const arrays = contributions.filter((entry) => Array.isArray(entry.value));
	if (arrays.length === 0) {
		const winner = contributions[contributions.length - 1];
		stamp(provenance, winner, key);
		return winner.value;
	}
	const strategy: MergeStrategy = mergeStrategyOf(schema);
	const keyed = keyedField(strategy);
	if (keyed !== undefined) {
		return mergeKeyedArray(arrays, schema, keyed, key, provenance);
	}
	if (strategy === "append") return appendArrays(arrays, key, provenance);

	// `replace`: the highest-precedence contributor supplies the whole array,
	// and one provenance entry at the array's own pointer says who. Per-element
	// entries would be noise: every element has the same answer.
	const winner = arrays[arrays.length - 1];
	stamp(provenance, winner, key);
	return [...(winner.value as ConfigValue[])];
}

function appendArrays(
	arrays: readonly Contribution[],
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue {
	const out: ConfigValue[] = [];
	for (const entry of arrays) {
		for (const member of entry.value as ConfigValue[]) {
			stamp(provenance, entry, `${key}/${out.length}`);
			out.push(member);
		}
	}
	// The array itself is attributed to its lowest-precedence contributor: with
	// `append`, that is the tier the list STARTED at.
	stamp(provenance, arrays[0], key);
	return out;
}

/**
 * `keyed:<field>` — match entries across tiers by `<field>` and merge them
 * field-wise, so a project file can override one server's `command` without
 * restating the whole catalog entry, and without erasing the sibling entries.
 *
 * Entries missing the key field cannot be matched, so they are appended in
 * contribution order and attributed to their own source. Dropping them would be
 * silent data loss; matching them together would merge unrelated entries.
 */
function mergeKeyedArray(
	arrays: readonly Contribution[],
	schema: ConfigSchemaNode | undefined,
	field: string,
	key: string,
	provenance: Map<string, Provenance>,
): ConfigValue {
	const items = itemsSchema(schema);
	const order: string[] = [];
	const groups = new Map<string, Contribution[]>();
	const unkeyed: Contribution[] = [];

	for (const entry of arrays) {
		for (const member of entry.value as ConfigValue[]) {
			const identity = keyIdentity(member, field);
			const memberContribution: Contribution = {
				source: entry.source,
				value: member,
				rank: entry.rank,
			};
			if (identity === undefined) {
				unkeyed.push(memberContribution);
				continue;
			}
			const group = groups.get(identity);
			if (group) {
				group.push(memberContribution);
				continue;
			}
			order.push(identity);
			groups.set(identity, [memberContribution]);
		}
	}

	const out: ConfigValue[] = [];
	const pushMerged = (group: readonly Contribution[]): void => {
		const merged = mergeNode(group, items, `${key}/${out.length}`, provenance);
		// An entry can only merge to `undefined` when its group is empty, which
		// the construction above cannot produce; dropping it keeps the resolved
		// list free of holes either way.
		if (merged !== undefined) out.push(merged);
	};
	for (const identity of order) pushMerged(groups.get(identity) ?? []);
	for (const entry of unkeyed) pushMerged([entry]);
	// Attribute the list itself to its lowest-precedence contributor, matching
	// `append`: a keyed list is a list every tier extends, not one a tier owns.
	stamp(provenance, arrays[0], key);
	return out;
}

function keyIdentity(member: ConfigValue, field: string): string | undefined {
	if (!isConfigObject(member)) return undefined;
	const value = member[field];
	if (typeof value === "string") return `s:${value}`;
	if (typeof value === "number" && Number.isFinite(value)) {
		return `n:${String(value)}`;
	}
	return undefined;
}
