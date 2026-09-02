/**
 * The stability registry for pi-lens's PUBLIC config surfaces (#2418).
 *
 * At ~28k downloads/month a config field or a warning string becomes a
 * compatibility obligation the moment it ships. This module is the one place
 * that obligation is written down as DATA, so the policy in
 * `docs/public-api-stability.md` is enforceable by test rather than by
 * convention:
 *
 * - `STABILITY_TIERS` / `STABILITY_TIER_KEY` — the `x-stability` annotation
 *   every published schema property must carry. New fields default to
 *   `experimental`; only `stable` fields are covered by the compatibility
 *   guarantee. Promotion is a deliberate, changelogged act.
 * - `CONFIG_SCHEMA_ID` / `CONFIG_SCHEMA_ANCHOR_KEY` — the reserved schema
 *   identity anchor the unified config envelope carries from its first
 *   published version (#2416 populates it; nothing here emits config).
 * - `CONFIG_DIAGNOSTIC_CODES` — a closed, APPEND-ONLY namespace of stable
 *   codes for user-facing config validation and migration warnings, so a user
 *   can match or suppress on `PILENS_CFG_0001` instead of on prose. Message
 *   text may change freely; codes may never be renumbered or removed.
 * - `DEPRECATED_CONFIG_SURFACES` — the deprecation window (`deprecatedSince` /
 *   `removeNotBefore`) for every legacy config key and file location that is
 *   still read. Removal happens only in a major, through the documented
 *   breaking-change checklist.
 *
 * Deliberately DEPENDENCY-FREE: this is a data leaf imported by the config
 * loaders, the degradation ledger seam, and the governance tests. It must
 * never grow an import on a module that itself reports config diagnostics.
 */

// --- Field stability tiers (policy point 1) ---

/** The JSON Schema annotation key carrying a field's stability tier. */
export const STABILITY_TIER_KEY = "x-stability";

/**
 * The closed tier vocabulary. `experimental` fields may change or be removed
 * in a minor; `stable` fields are covered by the compatibility guarantee.
 */
export const STABILITY_TIERS = ["experimental", "stable"] as const;

export type StabilityTier = (typeof STABILITY_TIERS)[number];

export function isStabilityTier(value: unknown): value is StabilityTier {
	return (
		typeof value === "string" &&
		(STABILITY_TIERS as readonly string[]).includes(value)
	);
}

// --- Config envelope identity (policy point 3) ---

/**
 * The reserved `$schema` URL for the unified pi-lens config envelope. Pinned
 * here from the first published version so the identity anchor cannot drift
 * between the schema, the validator, and the docs. #2416 is the first consumer.
 */
export const CONFIG_SCHEMA_ID =
	"https://raw.githubusercontent.com/apmantza/pi-lens/master/docs/schema/pi-lens-config-v1.json";

/** The envelope key carrying `CONFIG_SCHEMA_ID` in a user's config file. */
export const CONFIG_SCHEMA_ANCHOR_KEY = "$schema";

// --- Stable config diagnostic codes (policy point 2) ---

/**
 * APPEND-ONLY. Add new codes at the end with the next number; never renumber,
 * never delete, never reuse a retired number. A retired code keeps its entry
 * with its description amended — `tests/clients/config-diagnostic-codes.test.ts`
 * pins the full list and goes red on any renumber or removal.
 */
export const CONFIG_DIAGNOSTIC_CODES = {
	/** A config file exists but could not be read or parsed, so it is ignored. */
	PILENS_CFG_0001: "config file unreadable or unparsable; ignored",
	/** A deprecated config KEY was accepted inside its deprecation window. */
	PILENS_CFG_0002: "deprecated config key accepted",
	/** A deprecated config FILE LOCATION was read inside its window. */
	PILENS_CFG_0003: "deprecated config file location accepted",
} as const satisfies Record<`PILENS_CFG_${string}`, string>;

export type ConfigDiagnosticCode = keyof typeof CONFIG_DIAGNOSTIC_CODES;

/** The shape every code in the namespace must match. */
export const CONFIG_DIAGNOSTIC_CODE_PATTERN = /^PILENS_CFG_\d{4}$/;

export function isConfigDiagnosticCode(
	value: unknown,
): value is ConfigDiagnosticCode {
	return (
		typeof value === "string" && Object.hasOwn(CONFIG_DIAGNOSTIC_CODES, value)
	);
}

/** The registered description for a code, or `undefined` when unregistered. */
export function getConfigDiagnosticCode(code: string): string | undefined {
	return isConfigDiagnosticCode(code)
		? CONFIG_DIAGNOSTIC_CODES[code]
		: undefined;
}

/**
 * The user-visible marker appended to a coded message: ` [PILENS_CFG_0001]`.
 * Kept as a bracketed suffix so it is greppable and suppressible without
 * depending on any prose before it.
 */
export function configDiagnosticMarker(code: ConfigDiagnosticCode): string {
	return `[${code}]`;
}

/** Append a code marker to a message, unless the message already carries it. */
export function withConfigDiagnosticCode(
	message: string,
	code: ConfigDiagnosticCode,
): string {
	const marker = configDiagnosticMarker(code);
	return message.includes(marker) ? message : `${message} ${marker}`;
}

/** Matches the marker suffix in rendered messages (capture group 1 = code). */
export const CONFIG_DIAGNOSTIC_MARKER_PATTERN = /\[(PILENS_CFG_\d{4})\]/;

// --- Deprecation windows (policy point 4) ---

export type DeprecatedConfigSurfaceKind = "key" | "file";

export interface DeprecatedConfigSurface {
	/** A config KEY name, or a config FILE path/basename. */
	readonly surface: string;
	readonly kind: DeprecatedConfigSurfaceKind;
	/** The stable code the migration warning for this surface carries. */
	readonly code: ConfigDiagnosticCode;
	/** Version in which the surface was announced deprecated. */
	readonly deprecatedSince: string;
	/** Earliest version in which removal is permitted (always a major). */
	readonly removeNotBefore: string;
	readonly reason: string;
}

/**
 * The legacy config surfaces pi-lens still reads. Each row commits to being
 * read for one deprecation window and then ACTUALLY removed at
 * `removeNotBefore` — legacy sources are not carried forever. Removal routes
 * through the #2372 slice-5 breaking-change plan, which instantiates the
 * checklist in `docs/public-api-stability.md`.
 *
 * The consolidation slice (#2426) blesses exactly two canonical locations:
 * `.pi-lens.json` (project) and `~/.pi-lens/config.json` (global).
 */
export const DEPRECATED_CONFIG_SURFACES = [
	{
		surface: "servers",
		kind: "key",
		code: "PILENS_CFG_0002",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"custom-server definitions move to the unified catalog schema; the bare string command + args form is replaced by the trust-gated ProcessSpec (#2416).",
	},
	{
		surface: "serverOverrides",
		kind: "key",
		code: "PILENS_CFG_0002",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"per-server initializationOptions overrides fold into the catalog's field-wise merge, keyed by the same public server IDs (#2416).",
	},
	{
		surface: "disabledServers",
		kind: "key",
		code: "PILENS_CFG_0002",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"replaced by the catalog's per-entry `enabled: false`, which carries monotonic deny precedence (#1416/#2415).",
	},
	{
		surface: "warmFiles",
		kind: "key",
		code: "PILENS_CFG_0002",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"session warm-up seeds become a per-server catalog field rather than a config-root list (#2416).",
	},
	{
		surface: ".pi-lens/lsp.json",
		kind: "file",
		code: "PILENS_CFG_0003",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"project LSP settings consolidate into `.pi-lens.json` under the unified envelope (#2426).",
	},
	{
		surface: ".pi-lens.json",
		kind: "file",
		code: "PILENS_CFG_0003",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"the FILE stays canonical; its legacy top-level LSP keys (read as an `LSPConfig` root) move under the unified envelope (#2426).",
	},
	{
		surface: "pi-lsp.json",
		kind: "file",
		code: "PILENS_CFG_0003",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"pre-rename project location; superseded by `.pi-lens.json` (#2426).",
	},
	{
		surface: "pi-lens.json",
		kind: "file",
		code: "PILENS_CFG_0003",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"undotted project-config basename; superseded by `.pi-lens.json` (#2426).",
	},
	{
		surface: "~/.pi-lens/lsp.json",
		kind: "file",
		code: "PILENS_CFG_0003",
		deprecatedSince: "4.1.3",
		removeNotBefore: "5.0.0",
		reason:
			"global LSP settings consolidate into `~/.pi-lens/config.json` (#2426).",
	},
] as const satisfies readonly DeprecatedConfigSurface[];
