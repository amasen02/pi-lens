/**
 * THE shared config core (#2425). Every future config loader, catalog, and
 * selector resolves through this module rather than growing a fourth merge
 * semantics of its own.
 *
 * The pipeline, in one line:
 *
 *   RawConfig -> validate(schema) -> NormalizedConfig -> merge(sources) -> Resolved<T>
 *
 * `resolveConfig` runs both halves and is the front door. It is a pure function
 * of its arguments: no file reads, no ledger writes, no logging. Reporting is a
 * separate, explicit step (`reportMigrationRecords`), so a caller decides when a
 * user gets warned and under which subsystem — a library that warns on its own
 * would fragment the warn-once latch across every consumer.
 *
 * NOTHING IN THIS PR WIRES A LOADER. The migration targets are
 * `clients/lsp/config.ts` (`loadLSPConfig`), `clients/lens-config.ts`
 * (`loadPiLensGlobalConfig`), and `clients/project-lens-config.ts`
 * (`loadPiLensProjectConfig`); #2426 adopts them, and #2416 brings the first
 * real schema. Zero runtime behavior change is an acceptance criterion here.
 */

export {
	type AdditionalPropertyPolicy,
	additionalPropertyPolicy,
	type ConfigSchemaNode,
	type ConfigValue,
	DEFAULT_MERGE_STRATEGY,
	DENY_KEY,
	DENY_POLICIES,
	type DenyPolicy,
	denyPolicyOf,
	isDenyPolicy,
	isConfigObject,
	isKnownSchemaType,
	isMergeStrategy,
	isPlainObject,
	isSchemaNode,
	itemsSchema,
	keyedField,
	MERGE_STRATEGY_KEY,
	type MergeStrategy,
	mergeStrategyOf,
	propertySchema,
	SCHEMA_TYPES,
	schemaType,
	STABILITY_TIER_KEY,
} from "./schema.js";

export {
	compareKeys,
	isOperatorTier,
	isRepoTier,
	type Provenance,
	type ProvenanceView,
	type ProvenanceViewEntry,
	provenanceFor,
	provenanceView,
	type Resolved,
	SOURCE_TIERS,
	type SourceTier,
	TIER_CLASS,
	TIER_PRECEDENCE,
	type TierClass,
	tierPrecedence,
	type TrustDecision,
} from "./provenance.js";

export {
	isUnsafeConfigKey,
	MAX_CONFIG_DEPTH,
	safeAssign,
	UNSAFE_CONFIG_KEYS,
	UNSAFE_KEY_REASON,
} from "./safe-object.js";

export {
	type DenyContribution,
	type DenyResolution,
	denyProvenance,
	resolveArrayDeny,
	resolveBooleanDeny,
} from "./deny.js";

export {
	type NormalizedConfig,
	type ValidateOptions,
	validate,
} from "./normalize.js";

// `merge()` itself is NOT re-exported. Its input type only PROMISES a
// post-`validate()` value; nothing in the language enforces that a caller
// who imports it directly honors the promise, and `merge()`'s own bounds are
// a narrow backstop, not a second validator (see `merge.ts`'s module doc).
// `resolveConfig` below is the one supported way in: it always validates
// every source before merging. `merge()` stays exported from `merge.ts`
// itself — marked `@internal` there — for this module's own use and for
// tests that probe it directly.
export { type ConfigSource, type MergeOptions } from "./merge.js";

export {
	boundedKeyLabel,
	jsonTypeName,
	MAX_MIGRATION_RECORDS,
	MAX_RECORD_KEY_LENGTH,
	type MigrationRecord,
	MigrationRecordCollector,
	migrationSubject,
	reportMigrationRecords,
} from "./records.js";

export {
	buildProcessSpec,
	type CwdMode,
	type InputMode,
	MAX_ARGV_BYTES,
	MAX_ARGV_ENTRIES,
	MAX_ENV_BYTES,
	MAX_ENV_ENTRIES,
	MAX_TIMEOUT_MS,
	type ProcessSpec,
	type ProcessSpecInput,
	type ProcessSpecRejection,
	type ProcessSpecRejectionCode,
	type ProcessSpecResult,
	type RedactedProcessSpec,
	redactProcessSpec,
	type SpawnArgs,
	type SpawnArgsResult,
	toSpawnArgs,
	type TrustRefusal,
} from "./process-spec.js";

import { type ConfigSource, merge } from "./merge.js";
import { validate } from "./normalize.js";
import type { Resolved } from "./provenance.js";
import { MigrationRecordCollector, type MigrationRecord } from "./records.js";
import type { ConfigSchemaNode } from "./schema.js";

/** One source as the caller has it: parsed, not yet validated. */
export interface RawConfigSource extends Omit<ConfigSource, "value"> {
	/** Whatever the parser produced. */
	readonly value: unknown;
}

export interface ResolveConfigOptions {
	readonly sources: readonly RawConfigSource[];
	readonly schema: ConfigSchemaNode;
	/**
	 * Cap on records across the WHOLE resolution, not per source. Ten broken
	 * files must not multiply the bound by ten.
	 */
	readonly maxRecords?: number;
}

export interface ConfigResolution<T> {
	readonly resolved: Resolved<T>;
	readonly records: readonly MigrationRecord[];
	readonly droppedRecordCount: number;
}

/**
 * Validate every source, then merge them.
 *
 * One collector spans the whole resolution, so the record bound is per
 * resolution rather than per file. Sources are handed to `merge` in the order
 * given; `merge` sorts them by tier precedence itself.
 *
 * NEVER THROWS, and that is a contract rather than an observation (#2440
 * review). `validate` already promised it and enforced it with its own guard,
 * but the front door called `merge` outside any guard, so a value that reached
 * the merger in a shape it could not survive — the review's probe was a
 * 4000-deep blob under an opaque schema node — turned a config load into a
 * `RangeError` that took the session with it. The bounds inside both halves are
 * the real fix; this guard is the floor under them, so a future bug in either
 * half degrades a config to absent instead of failing a session.
 */
export function resolveConfig<T = unknown>(
	options: ResolveConfigOptions,
): ConfigResolution<T> {
	const collector = new MigrationRecordCollector(options.maxRecords);
	try {
		const normalized: ConfigSource[] = options.sources.map((source) => ({
			tier: source.tier,
			...(source.file === undefined ? {} : { file: source.file }),
			...(source.trust === undefined ? {} : { trust: source.trust }),
			value: validate(source.value, options.schema, {
				file: source.file ?? "",
				collector,
			}).value,
		}));
		return {
			resolved: merge<T>(normalized, options.schema, { collector }),
			records: collector.records,
			droppedRecordCount: collector.droppedCount,
		};
	} catch (error) {
		// The error CLASS only, never its message, which could quote the file.
		collector.add({
			code: "PILENS_CFG_0005",
			file: "",
			key: "",
			subject: "",
			reason: `config resolution failed internally (${
				error instanceof Error ? error.name : "unknown error"
			}); configuration ignored`,
		});
		return {
			// The empty resolution, built by the merger from no sources rather than
			// asserted into existence: `merge([])` is already "nothing resolved".
			resolved: merge<T>([], options.schema),
			records: collector.records,
			droppedRecordCount: collector.droppedCount,
		};
	}
}
