/**
 * The validate/normalize half of the config pipeline (#2425, scope item 1).
 *
 * `RawConfig` (whatever `JSON.parse` returned) -> `validate(schema)` ->
 * `NormalizedConfig` (only fields the schema claims, each of the declared
 * shape). `merge.ts` then combines normalized configs across tiers, so the
 * merger never has to ask whether a value is the type it looks like.
 *
 * Three rules, all from `docs/public-api-stability.md`:
 *
 * 1. NEVER THROW. A user's config file is untrusted input; a schema violation
 *    degrades that field to absent and records why. A throw here would take
 *    down a session over a typo.
 * 2. UNKNOWN FIELDS ARE DROPPED, NOT KEPT. pi-lens's default is closed, unlike
 *    JSON Schema's — a schema opts into openness with `additionalProperties`.
 *    Keeping unknown fields would make every typo a silently-ignored setting,
 *    which is the failure users actually report.
 * 3. EVERY DROP IS RECORDED, with a stable `PILENS_CFG_*` code and a reason
 *    built from structure alone. No value ever reaches a record.
 *
 * The walk is bounded on both axes that can grow: depth (a hand-written config
 * can nest arbitrarily) and record count (`MigrationRecordCollector`). Objects
 * already visited on the current path are refused, so a caller that hands in a
 * cyclic value gets a record rather than a stack overflow.
 */

import {
	type ConfigSchemaNode,
	type ConfigValue,
	additionalPropertyPolicy,
	isPlainObject,
	isSchemaNode,
	itemsSchema,
	propertySchema,
	schemaType,
} from "./schema.js";
import {
	boundedKeyLabel,
	jsonTypeName,
	MigrationRecordCollector,
	type MigrationRecord,
	migrationSubject,
} from "./records.js";

/**
 * A config whose every field is one the schema claims, of the declared type.
 *
 * The "RawConfig" of the pipeline description is deliberately NOT a type alias
 * here: naming `unknown` adds a word and no information, and every consumer
 * would still narrow from scratch. The raw shape lives at exactly one place in
 * the codebase — `validate`'s first parameter — and says `unknown` there.
 */
export interface NormalizedConfig {
	/** `undefined` when the whole document was rejected. */
	readonly value: ConfigValue | undefined;
	readonly records: readonly MigrationRecord[];
	/** Records the bound discarded. Counted, never silently zero. */
	readonly droppedRecordCount: number;
}

/**
 * Deepest nesting the validator walks. A config is a settings document, not a
 * tree; 32 levels is far past anything a human writes and far short of a stack
 * overflow. Deeper nodes are dropped with a record rather than truncated
 * silently.
 */
export const MAX_CONFIG_DEPTH = 32;

export interface ValidateOptions {
	/** The file the raw config came from, for the records' `file` field. */
	readonly file?: string;
	/** Share one collector across several sources so the bound is per resolution. */
	readonly collector?: MigrationRecordCollector;
}

/** Sentinel for "this node produced no value". `undefined` is a legal JSON absence. */
const DROPPED = Symbol("dropped");

type Walked = ConfigValue | typeof DROPPED;

export function validate(
	raw: unknown,
	schema: ConfigSchemaNode,
	options: ValidateOptions = {},
): NormalizedConfig {
	const collector = options.collector ?? new MigrationRecordCollector();
	const file = options.file ?? "";
	const context: WalkContext = { collector, file, path: [] };
	let walked: Walked;
	try {
		walked = walk(raw, schema, context, 0, new Set());
	} catch (error) {
		// A throw here is a bug in this module, not in the user's config, but the
		// contract above still holds: a config load never fails a session. The
		// record says the document was dropped and names the error CLASS only,
		// never its message, which could quote the file.
		record(context, {
			code: "PILENS_CFG_0005",
			key: "",
			reason: `config validation failed internally (${
				error instanceof Error ? error.name : "unknown error"
			}); document ignored`,
		});
		walked = DROPPED;
	}
	return {
		value: walked === DROPPED ? undefined : walked,
		records: collector.records,
		droppedRecordCount: collector.droppedCount,
	};
}

interface WalkContext {
	readonly collector: MigrationRecordCollector;
	readonly file: string;
	path: string[];
}

function pointerOf(path: readonly string[]): string {
	return path.length === 0 ? "" : `/${path.join("/")}`;
}

function record(
	context: WalkContext,
	entry: {
		code: MigrationRecord["code"];
		key: string;
		reason: string;
	},
): void {
	const key = boundedKeyLabel(entry.key);
	context.collector.add({
		code: entry.code,
		file: context.file,
		key,
		subject: migrationSubject(context.file, key),
		reason: entry.reason,
	});
}

function walk(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	const pointer = pointerOf(context.path);
	if (depth > MAX_CONFIG_DEPTH) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointer,
			reason: `config nesting exceeds ${MAX_CONFIG_DEPTH} levels; ignored`,
		});
		return DROPPED;
	}
	if (typeof value === "object" && value !== null) {
		if (onPath.has(value)) {
			record(context, {
				code: "PILENS_CFG_0005",
				key: pointer,
				reason: "config value refers to itself; ignored",
			});
			return DROPPED;
		}
	}

	const declared = schemaType(schema);
	if (declared === "object")
		return walkObject(value, schema, context, depth, onPath);
	if (declared === "array")
		return walkArray(value, schema, context, depth, onPath);
	if (declared !== undefined)
		return walkScalar(value, schema, context, declared);

	// The opaque tail: the schema declares no `type`, so the value passes through
	// as it stands. It reaches the domain type by assertion because the only
	// producer is a JSON parser, which cannot make anything else.

	// No `type` keyword: the schema is opaque about this node. Descend anyway
	// when the VALUE is an object and the schema names properties, so a schema
	// that omits the redundant `type: "object"` still gets field-wise treatment
	// rather than silently becoming an opaque blob the merger replaces whole.
	if (schema && isSchemaNode(schema.properties) && isPlainObject(value)) {
		return walkObject(value, schema, context, depth, onPath);
	}
	return checkEnum(value, schema, context) ? (value as ConfigValue) : DROPPED;
}

function walkObject(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	if (!isPlainObject(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected an object, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	const nextPath = onPath.add(value);
	const policy = additionalPropertyPolicy(schema);
	const out: Record<string, ConfigValue> = {};
	for (const [name, child] of Object.entries(value)) {
		const childSchema = propertySchema(schema, name);
		let effective: ConfigSchemaNode | undefined = childSchema;
		if (!childSchema) {
			if (policy.kind === "drop") {
				context.path.push(name);
				record(context, {
					code: "PILENS_CFG_0004",
					key: pointerOf(context.path),
					reason: "unknown config field; ignored",
				});
				context.path.pop();
				continue;
			}
			effective = policy.kind === "validate" ? policy.schema : undefined;
		}
		context.path.push(name);
		const walked = walk(child, effective, context, depth + 1, nextPath);
		context.path.pop();
		if (walked !== DROPPED) out[name] = walked;
	}
	nextPath.delete(value);
	return out;
}

function walkArray(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	if (!Array.isArray(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected an array, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	const nextPath = onPath.add(value);
	const items = itemsSchema(schema);
	const out: ConfigValue[] = [];
	for (const [index, entry] of value.entries()) {
		context.path.push(String(index));
		const walked = walk(entry, items, context, depth + 1, nextPath);
		context.path.pop();
		if (walked !== DROPPED) out.push(walked);
	}
	nextPath.delete(value);
	return out;
}

/**
 * Type PREDICATES, not plain booleans: a check that only returned `true` would
 * leave the caller re-asserting the very fact it had just proved.
 */
const SCALAR_CHECKS: Readonly<
	Record<string, (value: unknown) => value is ConfigValue>
> = {
	string: (value): value is ConfigValue => typeof value === "string",
	number: (value): value is ConfigValue =>
		typeof value === "number" && Number.isFinite(value),
	integer: (value): value is ConfigValue =>
		typeof value === "number" && Number.isInteger(value),
	boolean: (value): value is ConfigValue => typeof value === "boolean",
	null: (value): value is ConfigValue => value === null,
};

function walkScalar(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	declared: string,
): Walked {
	const check = SCALAR_CHECKS[declared];
	// An unrecognized `type` keyword is the schema's problem, not the user's:
	// pass the value through rather than rejecting a field nobody can satisfy.
	// Same JSON-parser provenance as the opaque tail in `walk`.
	if (!check) {
		return checkEnum(value, schema, context) ? (value as ConfigValue) : DROPPED;
	}
	if (!check(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected ${declared}, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	return checkEnum(value, schema, context) ? value : DROPPED;
}

/**
 * Enforce a declared `enum`. The record names the ALLOWED members, which are
 * schema text, and never the rejected value, which is user text.
 */
function checkEnum(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
): boolean {
	const allowed = schema?.enum;
	if (!Array.isArray(allowed)) return true;
	if (allowed.some((candidate) => Object.is(candidate, value))) return true;
	record(context, {
		code: "PILENS_CFG_0005",
		key: pointerOf(context.path),
		reason: `value is not one of ${allowed
			.map((candidate) => JSON.stringify(candidate))
			.join(", ")}; ignored`,
	});
	return false;
}
