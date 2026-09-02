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
	isMergeStrategy,
	isPlainObject,
	isSchemaNode,
	itemsSchema,
	keyedField,
	MERGE_STRATEGY_KEY,
	type MergeStrategy,
	mergeStrategyOf,
	propertySchema,
	schemaType,
	STABILITY_TIER_KEY,
} from "./schema.js";

export {
	isRepoTier,
	isSourceTier,
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
	type DenyContribution,
	type DenyResolution,
	denyProvenance,
	resolveArrayDeny,
	resolveBooleanDeny,
} from "./deny.js";

export {
	MAX_CONFIG_DEPTH,
	type NormalizedConfig,
	type ValidateOptions,
	validate,
} from "./normalize.js";

export { type ConfigSource, merge } from "./merge.js";

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
 */
export function resolveConfig<T = unknown>(
	options: ResolveConfigOptions,
): ConfigResolution<T> {
	const collector = new MigrationRecordCollector(options.maxRecords);
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
		resolved: merge<T>(normalized, options.schema),
		records: collector.records,
		droppedRecordCount: collector.droppedCount,
	};
}
