/**
 * The front door of the config pipeline: validate every source, then merge.
 *
 * It lives in its OWN module rather than in `index.ts` (#2426). `index.ts` is
 * the barrel, so anything importing it also pulls `process-spec.js` and, with
 * it, `project-trust.js` and the degradation ledger. That was harmless while
 * nothing downstream of `file-utils.ts` imported the core — and #2426 wires
 * three loaders that all sit downstream of it, which turned the barrel's width
 * into three extra import cycles that had nothing to do with what the loaders
 * actually use. A caller that only needs to resolve a config now imports only
 * the halves that resolve one.
 *
 * `index.ts` re-exports everything here, so the PUBLIC surface is unchanged and
 * `resolveConfig` is still the one supported way in.
 */
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
				tier: source.tier,
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
