/**
 * Bounded, redacted validation/migration records (#2425, scope item 6).
 *
 * A malformed config produces one record per rejected key, and a config file
 * can hold arbitrarily many keys, so the collection is bounded at the source
 * rather than at the sink. The bound reuses the degradation ledger's own
 * `ENTRIES_PER_KIND` discipline — the same number, imported rather than
 * re-typed, because a record that survives collection only to be dropped by the
 * ledger is memory spent for nothing.
 *
 * REASONS NEVER EMBED FILE CONTENT. Every reason on this surface is assembled
 * from a fixed template plus structural facts: a key name, a type name, a
 * count. No value, no snippet, no parser echo. #2431 is the sibling defect on
 * the existing loaders (a parse error carrying a source snippet); this module
 * does not fix it, and it does not repeat it. Key names are user text, so they
 * are stripped of control characters, length-bounded, and run through the
 * repo's existing `redactSecrets` before they reach a record.
 *
 * No module state: the collector is an instance a caller owns for the length of
 * one resolution, so there is no latch here to re-arm at `session_start`.
 */

import type { ConfigDiagnosticCode } from "../config-diagnostic-codes.js";
import {
	type IgnoredConfigSubsystem,
	warnIgnoredConfigOnce,
} from "../config-warn.js";
import { DEGRADATION_ENTRIES_PER_KIND } from "../degradation-ledger.js";
import { redactSecrets } from "../redact/secrets.js";

/**
 * One rejected or migrated config key.
 *
 * `subject` is the ledger identity (`<file>\0<key>`, or a bare `<file>` for a
 * whole-file record). It is stored rather than derived at the sink, so the
 * record a test inspects is the record the ledger counts.
 */
export interface MigrationRecord {
	readonly code: ConfigDiagnosticCode;
	readonly file: string;
	readonly key: string;
	readonly subject: string;
	/** Structural description. Never the offending value. */
	readonly reason: string;
}

/**
 * Records retained per resolution. The same value and the same reasoning as the
 * ledger's per-kind bound: everything past it is counted, not kept.
 */
export const MAX_MIGRATION_RECORDS = DEGRADATION_ENTRIES_PER_KIND;

/** Longest key label a record carries. A key is a name, not a document. */
export const MAX_RECORD_KEY_LENGTH = 120;

/**
 * The NUL separator `warnIgnoredConfigOnce` puts between file and key. Built
 * from its code point rather than written literally, so a literal NUL never
 * enters this source file.
 */
const SUBJECT_SEPARATOR = String.fromCharCode(0);

/** The ledger subject for a (file, key) pair; a bare file when there is no key. */
export function migrationSubject(file: string, key: string): string {
	return key.length > 0 ? `${file}${SUBJECT_SEPARATOR}${key}` : file;
}

/**
 * Replace every control character with a space.
 *
 * Written as a code-point scan rather than a character-class regex so this
 * source file contains no literal control byte of its own.
 */
function stripControlCharacters(text: string): string {
	let out = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : character;
	}
	return out;
}

/**
 * Make a user-supplied key safe to quote in a diagnostic: strip control
 * characters (a config key can hold a newline, which would split one warning
 * across two log lines), bound the length, and run the result through the
 * repo's secret redactor in case the key itself spells one.
 */
export function boundedKeyLabel(key: string): string {
	const printable = stripControlCharacters(key).trim();
	const bounded =
		printable.length > MAX_RECORD_KEY_LENGTH
			? `${printable.slice(0, MAX_RECORD_KEY_LENGTH)}...`
			: printable;
	return redactSecrets(bounded);
}

/** A JSON type name for a value. Structural only: never the value itself. */
export function jsonTypeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * A bounded collector for one resolution.
 *
 * Deliberately an instance rather than a module singleton: a resolution is a
 * call, not a session, so the collector's lifetime is the call's lifetime and
 * nothing has to reset it on a session boundary (defect shape 17).
 */
export class MigrationRecordCollector {
	private readonly kept: MigrationRecord[] = [];
	private dropped = 0;
	private readonly limit: number;

	constructor(limit: number = MAX_MIGRATION_RECORDS) {
		this.limit = Math.max(0, Math.trunc(limit));
	}

	add(record: MigrationRecord): void {
		if (this.kept.length >= this.limit) {
			this.dropped += 1;
			return;
		}
		this.kept.push(record);
	}

	/** The retained records, oldest first. */
	get records(): readonly MigrationRecord[] {
		return this.kept;
	}

	/** How many records the bound discarded. Counted, never silently zero. */
	get droppedCount(): number {
		return this.dropped;
	}

	/** Total produced: retained plus dropped. */
	get totalCount(): number {
		return this.kept.length + this.dropped;
	}
}

/**
 * Thread collected records to the ONE config warning seam (#2418).
 *
 * The subsystem is the caller's, not this module's: `warnIgnoredConfigOnce`
 * keys its latch and its `extension.log` line on the loader that is ignoring
 * the config, and config-core is a library every loader calls rather than a
 * loader of its own. #2426 is the forcing function — it is the slice that gives
 * each of the three loaders a call to this function.
 */
export function reportMigrationRecords(
	records: readonly MigrationRecord[],
	subsystem: IgnoredConfigSubsystem,
): void {
	for (const record of records) {
		warnIgnoredConfigOnce({
			subsystem,
			file: record.file,
			key: record.key.length > 0 ? record.key : undefined,
			reason: record.reason,
			code: record.code,
		});
	}
}
