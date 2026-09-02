/**
 * The ONE seam for "a config the user wrote is being ignored" (#2418).
 *
 * Three loaders — `clients/lsp/config.ts`, `clients/lens-config.ts`,
 * `clients/project-lens-config.ts` — each degraded a malformed config to
 * defaults and warned about it, with three near-identical bodies: a warn-once
 * latch, a `logExtension` line, and a `notifyUserDegradation` call. Three
 * copies meant three places to forget the stable diagnostic code, and three
 * places for the message shape to drift. They now share this helper, which
 * owns all four obligations:
 *
 * 1. the warn-once latch, keyed on (subsystem, file, key, reason) so a repeat
 *    load of the same broken file does not re-nag the user;
 * 2. the MACHINE-audience `extension.log` line;
 * 3. the durable degradation-ledger row, through the repo's existing
 *    `recordDegradationOnce` choke point rather than a parallel tally;
 * 4. the HUMAN-audience notification, carrying the stable `PILENS_CFG_*` code
 *    that `docs/public-api-stability.md` makes the user's match key.
 *
 * The message prose is assembled here from a per-subsystem label so every
 * caller's rendered string is byte-identical to what it emitted before the
 * extraction — the prose is not API (the code is), but silently rewording a
 * warning inside a refactor is still not a thing this PR does.
 */

import type { ConfigDiagnosticCode } from "./config-diagnostic-codes.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";
import { notifyUserDegradation } from "./user-notify.js";

/**
 * The config loaders that can report an ignored config. A closed union rather
 * than a free string: the latch key and the log's `subsystem` field are the
 * same value, so an ad-hoc caller cannot fragment either one.
 */
export type IgnoredConfigSubsystem =
	| "lsp-config"
	| "lens-config"
	| "project-lens-config";

/**
 * The noun each subsystem uses for the config it is ignoring. These strings
 * are load-bearing for byte-identical prose: `ignoring invalid LSP config …`,
 * `… global config …`, `… project config …` are what shipped before #2418
 * extracted this helper, and `tests/clients/lsp/config.test.ts` +
 * `tests/clients/project-lens-config.test.ts` still assert on them.
 */
const SUBSYSTEM_CONFIG_LABEL: Record<IgnoredConfigSubsystem, string> = {
	"lsp-config": "LSP config",
	"lens-config": "global config",
	"project-lens-config": "project config",
};

/**
 * The code every ignored-config warning carries: PILENS_CFG_0001, "config file
 * unreadable or unparsable; ignored". Named here rather than repeated at three
 * call sites so the registry entry has exactly one referent in production code.
 */
const IGNORED_CONFIG_CODE: ConfigDiagnosticCode = "PILENS_CFG_0001";

/**
 * The degradation kind this helper records under. One kind for all three
 * loaders: the subject discriminates WHICH file, and `metadata.subsystem`
 * discriminates which loader, so aggregation answers both without a kind
 * explosion.
 */
const IGNORED_CONFIG_KIND = "config-ignored";

/** Warn-once latch, keyed on (subsystem, file, key, reason). */
const warnedIgnoredConfigs = new Set<string>();

export interface WarnIgnoredConfigOptions {
	/** Which loader is ignoring the config; also the `extension.log` subsystem. */
	readonly subsystem: IgnoredConfigSubsystem;
	/** The config file being ignored, as the loader knows it. */
	readonly file: string;
	/** Why it is being ignored — a parse error, a bad value, a wrong type. */
	readonly reason: string;
	/**
	 * The offending KEY inside the file, when the loader is rejecting one key
	 * rather than the whole file. Part of the ledger subject, so
	 * `<file>\0<key>` stays the identity a per-key degradation is counted under;
	 * a whole-file rejection is just `<file>`, with no trailing separator.
	 *
	 * No production caller passes it TODAY (#2418 review round 3, S1). It is
	 * kept rather than deleted because it is the forcing function for #2426:
	 * the legacy-location/legacy-key deprecation records land through this same
	 * helper as `PILENS_CFG_0002`/`0003`, and a per-KEY record that had to
	 * share a subject with the whole file would be uncountable. The audit that
	 * would otherwise flag it as dead is answered here, in one place, instead
	 * of by re-deriving the seam in three months.
	 */
	readonly key?: string;
	/**
	 * Override the stable diagnostic code. Defaults to `PILENS_CFG_0001`
	 * (unreadable/unparsable, ignored), which is what all three loaders mean
	 * today. The seam exists because `PILENS_CFG_0002`/`0003` (deprecated key /
	 * deprecated file location accepted) are registered and reserved for the
	 * #2416 migration path, and will report through this same helper.
	 */
	readonly code?: ConfigDiagnosticCode;
}

/**
 * Warn once that a config file (or one key in it) is being ignored.
 *
 * Fires the durable ledger row, the machine log, and the user-facing
 * notification. Every one of the three is bounded, but on two DIFFERENT
 * lifetimes: the latch here bounds the log line and the notification for the
 * life of the PROCESS, while `recordDegradationOnce` bounds the ledger row on
 * (kind, subject) for the life of the SESSION. That is why the ledger call sits
 * in front of the latch's early return — see the comment on it. The ledger
 * bound is also coarser, so a file failing for two different reasons warns
 * twice but is counted as one degraded config.
 */
export function warnIgnoredConfigOnce(options: WarnIgnoredConfigOptions): void {
	const { subsystem, file, reason, key } = options;
	const code: ConfigDiagnosticCode = options.code ?? IGNORED_CONFIG_CODE;

	// The durable half (#2418 F6), and it runs BEFORE the latch on purpose
	// (#2418 review round 3, F1). The latch is a PROCESS-lifetime Set; the
	// ledger is per SESSION, reset by `resetDegradationLedger()` at the top of
	// `handleSessionStart`. With the early return in front of this call, every
	// session after the first recorded nothing while the config on disk was
	// still ignored — the exact catalog-shape-17 defect
	// `refreshGrammarSessionLatches` exists to prevent in tree-sitter-client.
	//
	// No second, generation-compared latch is needed to re-arm it, unlike that
	// precedent: `recordDegradationOnce` already dedupes on (kind, subject)
	// through its own once-key set, and that set IS cleared by the ledger
	// reset. Calling it unconditionally makes the ledger the single source of
	// truth for "once per session", instead of a parallel Set here that mirrors
	// it and has to be kept in step. (tree-sitter needs its own gates because
	// they guard `incrementDegradationCount`, which counts EVERY call, plus
	// non-ledger state.)
	//
	// Subject is `<file>\0<key>` when a single key is rejected, and plain
	// `<file>` otherwise, so a per-key rejection and a whole-file rejection are
	// distinct rows for the same file without a trailing separator on every row.
	recordDegradationOnce({
		kind: IGNORED_CONFIG_KIND,
		subject: key ? `${file}\0${key}` : file,
		reason,
		metadata: { subsystem, configPath: file },
		code,
	});

	const latchKey = `${subsystem}\0${file}\0${key ?? ""}\0${reason}`;
	if (warnedIgnoredConfigs.has(latchKey)) return;
	warnedIgnoredConfigs.add(latchKey);

	const message = `ignoring invalid ${SUBSYSTEM_CONFIG_LABEL[subsystem]} ${file}: ${reason}`;

	logExtension({
		subsystem,
		level: "warn",
		message,
		metadata: { configPath: file, reason, code, ...(key ? { key } : {}) },
	});

	// HUMAN-audience too: a config the user wrote is being ignored. Routed
	// through the host's own render path (#1333), never a raw write. The stable
	// code (#2418) is what a user matches or suppresses on; the prose may still
	// change. Once per PROCESS, deliberately: re-nagging about the same broken
	// file at every session boundary is noise, while the ledger row above is
	// the per-session record.
	notifyUserDegradation(`pi-lens: ${message}`, "warning", { code });
}

/**
 * Clear the warn-once latch. Test-only seam, and the one the loaders' own
 * reset helpers delegate to — a subsystem argument clears just that loader's
 * entries so one loader's test cannot silently un-latch another's.
 */
export function resetIgnoredConfigWarnCache(
	subsystem?: IgnoredConfigSubsystem,
): void {
	if (!subsystem) {
		warnedIgnoredConfigs.clear();
		return;
	}
	for (const latchKey of warnedIgnoredConfigs) {
		if (latchKey.startsWith(`${subsystem}\0`)) {
			warnedIgnoredConfigs.delete(latchKey);
		}
	}
}
