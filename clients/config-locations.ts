/**
 * WHERE pi-lens config lives, and in what order (#2426).
 *
 * Before this module the answer was spread across three loaders with three
 * different walks: `lsp/config.ts` had its own `CONFIG_PATHS` and an UNBOUNDED
 * upward walk to the filesystem root, `project-lens-config.ts` had its own
 * `PROJECT_CONFIG_BASENAMES` and a second unbounded walk, and `lens-config.ts`
 * read one fixed path. Three walks meant three places for the #622/#625
 * ceiling rule to be forgotten, and it was: a `pi-lsp.json` sitting in `$HOME`
 * — or in `C:\` — was read for every project on the machine.
 *
 * There are exactly TWO canonical locations:
 *
 *   `.pi-lens.json`            — project, nearest-package-wins per field
 *   `~/.pi-lens/config.json`   — machine-global
 *
 * Everything else in `PROJECT_CONFIG_LOCATIONS` / `GLOBAL_CONFIG_LOCATIONS` is
 * legacy, read for the deprecation window declared in
 * `DEPRECATED_CONFIG_SURFACES` and then removed. This module does not restate
 * that membership: it DERIVES the legacy set from the registry and orders it,
 * and `tests/clients/config-locations.test.ts` pins that the derived set is
 * exactly the registry's `kind: "file"` rows. Registry owns WHICH surfaces are
 * deprecated; this module owns only their precedence.
 *
 * Pure data plus one walk. No file reads, no caching, no state.
 */

import * as os from "node:os";
import * as path from "node:path";
import { DEPRECATED_CONFIG_SURFACES } from "./config-diagnostic-codes.js";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.js";

/** The one canonical PROJECT config file. Never deprecated. */
export const CANONICAL_PROJECT_CONFIG_FILE = ".pi-lens.json";

/** Basename of the one canonical GLOBAL config file inside `~/.pi-lens/`. */
export const CANONICAL_GLOBAL_CONFIG_FILE = "config.json";

/** The key the LSP namespace lives under in BOTH canonical files. */
export const LSP_NAMESPACE_KEY = "lsp";

/** The `~/` prefix a global row in the registry carries. */
const GLOBAL_SURFACE_PREFIX = "~/.pi-lens/";

/** One place a config file may be found. */
export interface ConfigLocation {
	/** Path relative to the directory (or global dir) it is looked for in. */
	readonly relativePath: string;
	/**
	 * The `DEPRECATED_CONFIG_SURFACES` surface this location corresponds to, or
	 * `undefined` for a canonical location. Carried so a migration record cites
	 * the registry row rather than re-spelling the window.
	 */
	readonly surface?: string;
	/** True for every location on a removal schedule. */
	readonly legacy: boolean;
	/**
	 * True when the file's ROOT keys are LSP keys (`servers`, `warmFiles`, ...)
	 * rather than pi-lens config sections — i.e. the whole file is what the
	 * canonical files now carry under `lsp`. Derived from the basename rather
	 * than listed, so a new `*lsp.json` legacy row cannot be mis-shaped by
	 * forgetting a second list.
	 */
	readonly lspScoped: boolean;
}

const LEGACY_FILE_SURFACES: readonly string[] =
	DEPRECATED_CONFIG_SURFACES.filter((row) => row.kind === "file").map(
		(row) => row.surface,
	);

/**
 * The legacy LSP ROOT keys still accepted inside a canonical file. Derived from
 * the registry's `kind: "key"` rows so the accepted set and the deprecation
 * schedule cannot drift apart.
 */
export const LEGACY_ROOT_LSP_KEYS: readonly string[] =
	DEPRECATED_CONFIG_SURFACES.filter((row) => row.kind === "key").map(
		(row) => row.surface,
	);

function isLspScoped(relativePath: string): boolean {
	const base = path.posix.basename(relativePath.replace(/\\/g, "/"));
	return base === "lsp.json" || base === "pi-lsp.json";
}

function legacyLocation(relativePath: string, surface: string): ConfigLocation {
	return {
		relativePath,
		surface,
		legacy: true,
		lspScoped: isLspScoped(relativePath),
	};
}

/**
 * Project locations in ASCENDING precedence: the canonical file is LAST, so it
 * wins every collision with a legacy file in the same directory.
 *
 * This inverts one pre-#2426 rule deliberately. `lsp/config.ts` searched
 * `.pi-lens/lsp.json`, `.pi-lens.json`, `pi-lsp.json` and took the FIRST hit,
 * so a leftover `.pi-lens/lsp.json` silently beat the file the user was being
 * told to migrate to. A deprecated location that outranks the canonical one is
 * a migration that can never be completed.
 */
export const PROJECT_CONFIG_LOCATIONS: readonly ConfigLocation[] = [
	legacyLocation("pi-lens.json", "pi-lens.json"),
	legacyLocation("pi-lsp.json", "pi-lsp.json"),
	legacyLocation(path.posix.join(".pi-lens", "lsp.json"), ".pi-lens/lsp.json"),
	{
		relativePath: CANONICAL_PROJECT_CONFIG_FILE,
		legacy: false,
		lspScoped: false,
	},
];

/**
 * The project config BASENAMES a first-match-wins probe uses, in DESCENDING
 * precedence — canonical first. The inverse view of the table above, for the
 * two callers that look for one file in one directory rather than layering all
 * of them: `project-lens-config.ts`'s upward walk and `workspace-topology.ts`'s
 * directory-marker index.
 *
 * Derived here rather than restated there. Both of those modules carried their
 * OWN literal pair before (#2426 folded the first one in; the marker index's
 * copy outlived it), and two hand-maintained lists of the same filenames is the
 * mirror the single-source-of-truth rule forbids — the failure mode being a
 * table change that flips one probe's collision winner and not the other's.
 *
 * The LSP-scoped legacy locations are filtered out: their ROOT keys are LSP
 * settings, not the pi-lens config sections these two probes project.
 */
export const PROJECT_CONFIG_BASENAMES: readonly string[] =
	PROJECT_CONFIG_LOCATIONS.filter((location) => !location.lspScoped)
		.map((location) => location.relativePath)
		.reverse();

/** Global locations in ASCENDING precedence; canonical last, same rule. */
export const GLOBAL_CONFIG_LOCATIONS: readonly ConfigLocation[] = [
	legacyLocation("lsp.json", `${GLOBAL_SURFACE_PREFIX}lsp.json`),
	{
		relativePath: CANONICAL_GLOBAL_CONFIG_FILE,
		legacy: false,
		lspScoped: false,
	},
];

/**
 * Every legacy surface this module claims to read, for the registry-agreement
 * test. Exported rather than re-derived in the test, so the test compares the
 * SHIPPED set against the registry instead of comparing the registry to itself.
 */
export const DECLARED_LEGACY_FILE_SURFACES: readonly string[] = [
	...PROJECT_CONFIG_LOCATIONS,
	...GLOBAL_CONFIG_LOCATIONS,
]
	.filter((location) => location.legacy)
	.map((location) => location.surface as string);

/** The registry's own `kind: "file"` surfaces, for the same test. */
export const REGISTERED_LEGACY_FILE_SURFACES = LEGACY_FILE_SURFACES;

/**
 * Directories to look for a project config in, INNERMOST FIRST, stopping at the
 * `$HOME` ceiling.
 *
 * The ceiling is the whole point (#622/#625, #2426 scope item 1). `$HOME` and
 * every ancestor of it is refused, so a stray `pi-lsp.json` in the user's home
 * directory — or at the filesystem root — is not silently adopted by every
 * project on the machine. `isAtOrAboveHomeDir` is the shared primitive; a
 * private `dir === homedir()` check is the exact bug #625 catalogued, because
 * it stops at HOME but still reads everything above it.
 *
 * The MACHINE-GLOBAL config is not affected: it is read by absolute path from
 * `~/.pi-lens/`, never by walking into `$HOME` and finding it.
 */
export function configSearchDirs(
	startDir: string,
	homeDir: string = os.homedir(),
): string[] {
	const dirs: string[] = [];
	for (const dir of walkUpDirs(startDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		dirs.push(dir);
	}
	return dirs;
}
