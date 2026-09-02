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
	 * `<file>\0<key>` stays the identity a per-key degradation is counted under.
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
 * Fires the machine log, the durable ledger row, and the user-facing
 * notification, in that order. Every one of the three is bounded: the latch
 * here bounds the log line and the notification, and `recordDegradationOnce`
 * bounds the ledger row on (kind, subject) — which is coarser than the latch on
 * purpose, so a file failing for two different reasons warns twice but is
 * counted as one degraded config.
 */
export function warnIgnoredConfigOnce(options: WarnIgnoredConfigOptions): void {
	const { subsystem, file, reason, key } = options;
	const latchKey = `${subsystem}\0${file}\0${key ?? ""}\0${reason}`;
	if (warnedIgnoredConfigs.has(latchKey)) return;
	warnedIgnoredConfigs.add(latchKey);

	const code: ConfigDiagnosticCode = options.code ?? IGNORED_CONFIG_CODE;
	const message = `ignoring invalid ${SUBSYSTEM_CONFIG_LABEL[subsystem]} ${file}: ${reason}`;

	logExtension({
		subsystem,
		level: "warn",
		message,
		metadata: { configPath: file, reason, code, ...(key ? { key } : {}) },
	});

	// The durable half (#2418 F6): without this the ledger could not answer
	// "did this session ignore a config the user wrote", and the stable code
	// existed only in prose. Subject is `<file>\0<key>` so a per-key rejection
	// and a whole-file rejection are distinct rows for the same file.
	recordDegradationOnce({
		kind: IGNORED_CONFIG_KIND,
		subject: `${file}\0${key ?? ""}`,
		reason,
		metadata: { subsystem, configPath: file },
		code,
	});

	// HUMAN-audience too: a config the user wrote is being ignored. Routed
	// through the host's own render path (#1333), never a raw write. The stable
	// code (#2418) is what a user matches or suppresses on; the prose may still
	// change.
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
