/**
 * LSP Configuration for pi-lens
 *
 * Allows users to define custom LSP servers and override initialization options
 * for built-in servers via configuration.
 *
 * CANONICAL LOCATION (#2426): the `lsp` namespace of `.pi-lens.json` (project)
 * and `~/.pi-lens/config.json` (machine-global). `.pi-lens/lsp.json`,
 * `pi-lsp.json` and `~/.pi-lens/lsp.json` — and the four LSP keys at the ROOT
 * of a canonical file — are still read for their deprecation window
 * (`DEPRECATED_CONFIG_SURFACES`) and emit one migration warning per
 * `(file, key)` naming where the setting moves. The canonical spelling wins
 * every collision. `docs/configuration.md` documents the full lookup order;
 * discovery itself lives in `clients/config-resolve.ts`, which this module and
 * the other two loaders now share.
 *
 * Example — custom server (canonical spelling, inside `.pi-lens.json`):
 * {
 *   "lsp": {
 *     "servers": {
 *       "my-server": {
 *         "name": "My Custom LSP",
 *         "extensions": [".myext"],
 *         "command": "my-lsp-server",
 *         "args": ["--stdio"],
 *         "rootMarkers": ["package.json"]
 *       }
 *     }
 *   }
 * }
 *
 * Example — override initializationOptions for a built-in server:
 * {
 *   "lsp": {
 *     "serverOverrides": {
 *       "rust": {
 *         "initializationOptions": {
 *           "check": { "command": "clippy", "allTargets": true },
 *           "cargo": { "features": "all", "targetDir": true }
 *         }
 *       },
 *       "nix": {
 *         "initializationOptions": {
 *           "nixpkgs": { "expr": "import <nixpkgs> {}" }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * The `initializationOptions` object is deep-merged onto the server's built-in
 * defaults, so you only need to specify the keys you want to change or add.
 * User-supplied values win on conflicts at every level of nesting.
 *
 * Server IDs match the `id` field of each built-in server definition in
 * clients/lsp/server.ts (e.g. "rust", "nix", "bash", "python", "go", "ts").
 */

import {
	resetIgnoredConfigWarnCache,
	warnIgnoredConfigOnce,
} from "../config-warn.js";
import * as os from "node:os";
import path from "node:path";
import { BoundedLruCache } from "../bounded-cache.js";
import {
	lspSectionOf,
	recordsOwnedBy,
	reportPiLensConfigRecords,
	resolvePiLensConfig,
} from "../config-resolve.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import { getPiLensGlobalConfigPath } from "../lens-config.js";
import { launchLSP } from "./launch.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "./session-roots.js";
import {
	createRootDetector,
	LSP_SERVERS,
	resetLSPCaseSensitivityState,
	type LSPServerInfo,
} from "./server.js";

// --- Types ---

export interface CustomServerConfig {
	name: string;
	extensions: string[];
	command: string;
	args?: string[];
	rootMarkers?: string[];
	env?: Record<string, string>;
}

/**
 * Per-server initializationOptions overrides for built-in servers.
 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python", "go").
 */
export interface ServerInitOverride {
	/**
	 * Deep-merged onto the server's built-in initializationOptions defaults.
	 * User values win on key conflicts at every nesting level.
	 */
	initializationOptions?: Record<string, unknown>;
}

export interface LSPConfig {
	servers?: Record<string, CustomServerConfig>;
	/**
	 * Override initializationOptions for built-in servers.
	 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python").
	 * Each entry's `initializationOptions` is deep-merged onto the server's
	 * built-in defaults so you only need to specify the keys you want to change.
	 */
	serverOverrides?: Record<string, ServerInitOverride>;
	disabledServers?: string[];
	/** Files to open at session start to seed lazy LSP indexing (e.g., clangd). */
	warmFiles?: string[];
}

interface RegisteredLSPConfig {
	customServers: LSPServerInfo[];
	disabledServerIds: Set<string>;
	serverOverrides: Map<string, ServerInitOverride>;
}

// --- Config Loading ---

function warnInvalidLSPConfig(configPath: string, error: unknown): void {
	// One shared seam for all three config loaders (#2418): it owns the
	// warn-once latch, the extension.log line, the durable `config-ignored`
	// ledger row, and the stable-coded user notification. The rendered prose is
	// unchanged — `ignoring invalid LSP config <path>: <reason>`.
	//
	// `{ parseError: error }`, not a pre-stringified message: `error` here is
	// either a caught `JSON.parse` `SyntaxError` (whose message embeds a
	// snippet of the source file being parsed on Node >=20, #2431) or a caught
	// `fs.readFile` error, and `warnIgnoredConfigOnce` is the one seam that
	// decides how much of either survives into the three sinks it owns.
	warnIgnoredConfigOnce({
		subsystem: "lsp-config",
		file: configPath,
		reason: { parseError: error },
	});
}

/**
 * For tests that need to force the warn-once cache to reset between cases —
 * the LSP loader's counterpart to `resetGlobalConfigWarnCache` in
 * lens-config.ts and to the clear folded into `resetProjectLensConfigCache`
 * (#2418 review round 3, S3). Without it, this loader's cases had to lean on
 * every fixture landing in a fresh temp path to stay unlatched, which is a
 * property of the fixture rather than of the test.
 */
export function resetLSPConfigWarnCache(): void {
	resetIgnoredConfigWarnCache("lsp-config");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Load LSP configuration — a PROJECTION of the one resolved pi-lens config.
 *
 * Everything that used to be here (the candidate list, the unbounded upward
 * walk, the two-object merge with its four hand-patched keys) now lives in
 * `config-resolve.ts` and applies identically to the other two loaders. What is
 * left is the projection: pick the `lsp` section out of the resolved value and
 * shape it into `LSPConfig`.
 *
 * Three behaviors changed with the move, all of them deliberate and all of them
 * pinned by `tests/clients/config-golden-layouts.test.ts`:
 *
 * 1. THE WALK IS CEILING-BOUNDED. It used to run to the filesystem root with no
 *    `$HOME` stop, so a `pi-lsp.json` in the user's home directory was adopted
 *    by every project on the machine (#622/#625's class, and #2426's one
 *    outright bug fix rather than deprecation).
 * 2. THE CANONICAL FILE WINS. `.pi-lens.json` used to LOSE to a leftover
 *    `.pi-lens/lsp.json` in the same directory, which made the migration users
 *    are now being asked to perform impossible to complete.
 * 3. NESTED CONFIGS LAYER instead of the nearest one winning wholesale, which
 *    is the same nearest-wins-per-field rule `.pi-lens.json`'s `ignore` has had
 *    since #783.
 *
 * `homeDir` is a test seam only, matching `findNestedProjectMutationValue`'s.
 */
export async function loadLSPConfig(
	cwd: string,
	homeDir: string = os.homedir(),
): Promise<LSPConfig> {
	const resolution = resolvePiLensConfig({
		cwd,
		globalDir: getGlobalPiLensDir(),
		// `homeDir` is threaded, not dropped: it is the `$HOME` this call resolves
		// against, and the canonical global config is `$HOME/.pi-lens/config.json`
		// whenever `PI_LENS_CONFIG_PATH` does not override it. Production behavior
		// is unchanged (the default IS `os.homedir()`); what it buys is that the
		// seam means the same `$HOME` on both sides of the resolution, so a test
		// can exercise a relocated `PI_LENS_HOME` without reaching the real one.
		globalConfigPath: getPiLensGlobalConfigPath(homeDir),
		homeDir,
		onReadError: warnInvalidLSPConfig,
	});
	// Only the records this loader OWNS (#2426 review round 2, F2). The other two
	// loaders resolve the same documents and report the rest; reporting all of
	// them here produced a second notice per (file, key) — the warn-once latch is
	// keyed per subsystem — and labelled a project setting "deprecated LSP config".
	reportPiLensConfigRecords(
		recordsOwnedBy(resolution.records, "lsp"),
		"lsp-config",
	);

	const section = lspSectionOf(resolution.value);
	const config: LSPConfig = {};
	const servers = asRecord(section.servers);
	if (servers) config.servers = servers as Record<string, CustomServerConfig>;
	const serverOverrides = asRecord(section.serverOverrides);
	if (serverOverrides) {
		config.serverOverrides = serverOverrides as Record<
			string,
			ServerInitOverride
		>;
	}
	if (Array.isArray(section.disabledServers)) {
		config.disabledServers = section.disabledServers as string[];
	}
	if (Array.isArray(section.warmFiles)) {
		config.warmFiles = section.warmFiles as string[];
	}
	return config;
}

// --- Custom Server Factory ---

/**
 * Create LSPServerInfo from user configuration
 */
export function createCustomServer(
	config: CustomServerConfig,
	id: string,
): LSPServerInfo {
	return {
		id,
		name: config.name,
		extensions: config.extensions,
		root: config.rootMarkers
			? createRootDetector(config.rootMarkers)
			: async () => process.cwd(),
		async spawn(root) {
			const proc = await launchLSP(config.command, config.args ?? ["--stdio"], {
				cwd: root,
				env: config.env ? { ...process.env, ...config.env } : process.env,
			});
			return { process: proc };
		},
	};
}

// --- Registry Management ---

const EMPTY_CONFIG: RegisteredLSPConfig = {
	customServers: [],
	disabledServerIds: new Set(),
	serverOverrides: new Map(),
};

const workspaceConfigs = new BoundedLruCache<string, RegisteredLSPConfig>(32);
/** In-flight config initialization promises to prevent duplicate concurrent loads */
const configInFlight = new Map<string, Promise<void>>();

function normalizeWorkspacePath(cwd: string): string {
	return path.resolve(cwd);
}

function isSameOrChildPath(filePath: string, candidateRoot: string): boolean {
	if (filePath === candidateRoot) return true;
	return filePath.startsWith(`${candidateRoot}${path.sep}`);
}

function getConfigForFile(filePath: string): RegisteredLSPConfig {
	const resolvedFilePath = path.resolve(filePath);
	let bestMatch: { root: string; config: RegisteredLSPConfig } | undefined;

	for (const [root, config] of workspaceConfigs) {
		if (!isSameOrChildPath(resolvedFilePath, root)) continue;
		if (!bestMatch || root.length > bestMatch.root.length) {
			bestMatch = { root, config };
		}
	}

	return bestMatch?.config ?? EMPTY_CONFIG;
}

/**
 * Initialize LSP configuration (call at session start)
 * Deduplicates concurrent calls for the same workspace.
 */
export async function initLSPConfig(cwd: string): Promise<void> {
	const normalizedCwd = normalizeWorkspacePath(cwd);
	// #2052: this cwd is now a served session root. Registered BEFORE the
	// in-flight dedup return below, so a concurrent duplicate init still
	// registers it rather than returning early with the root unrecorded.
	registerSessionRoot(normalizedCwd);

	const existing = configInFlight.get(normalizedCwd);
	if (existing) return existing;

	const promise = (async () => {
		const config = await loadLSPConfig(cwd);
		const customServers: LSPServerInfo[] = [];
		const disabledServerIds = new Set(config.disabledServers ?? []);

		if (config.servers) {
			for (const [id, serverConfig] of Object.entries(config.servers)) {
				try {
					const server = createCustomServer(serverConfig, id);
					customServers.push(server);
				} catch {
					// pi-lens-ignore: missing-error-propagation — per-server registration, skip bad entries
				}
			}
		}

		const serverOverrides = new Map<string, ServerInitOverride>();
		if (config.serverOverrides) {
			for (const [id, entry] of Object.entries(config.serverOverrides)) {
				if (entry && typeof entry === "object" && !Array.isArray(entry)) {
					const initOpts = (entry as Record<string, unknown>)
						.initializationOptions;
					if (
						initOpts !== undefined &&
						typeof initOpts === "object" &&
						initOpts !== null &&
						!Array.isArray(initOpts)
					) {
						serverOverrides.set(id, {
							initializationOptions: initOpts as Record<string, unknown>,
						});
					}
				}
			}
		}

		workspaceConfigs.set(normalizedCwd, {
			customServers,
			disabledServerIds,
			serverOverrides,
		});
	})();

	configInFlight.set(normalizedCwd, promise);
	try {
		await promise;
	} finally {
		// Identity-guarded release (#1968's pattern): delete only if THIS run is
		// still the registered one. A bare delete-by-key lets a late-settling run
		// evict a live successor a second writer registered under the same cwd
		// mid-flight, after which the next caller starts a duplicate config load.
		if (configInFlight.get(normalizedCwd) === promise) {
			configInFlight.delete(normalizedCwd);
		}
	}
}

/**
 * Get all available servers (built-in + custom, minus disabled)
 */
export function getAllServers(filePath?: string): LSPServerInfo[] {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	const all = [...LSP_SERVERS, ...config.customServers];
	return all.filter((s) => !config.disabledServerIds.has(s.id));
}

/**
 * Check if a server is disabled
 */
export function isServerDisabled(serverId: string, filePath?: string): boolean {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	return config.disabledServerIds.has(serverId);
}

// --- Override getServersForFile to include custom servers

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath).toLowerCase();
	return getAllServers(filePath).filter((server) => {
		const extensions = server.extensions.map((value) => value.toLowerCase());
		const extensionMatch =
			extensions.includes(ext) || extensions.includes(base);
		if (!extensionMatch) return false;
		// #636: a server's extension match can be intentionally broader than what
		// it can usefully act on (zizmor attaches to "yaml" but only ever reports
		// on GitHub Actions workflow/action/dependabot paths). `pathFilter`, when
		// present, is an ADDITIONAL narrowing gate — never a widening one.
		return server.pathFilter ? server.pathFilter(filePath) : true;
	});
}

/**
 * The primary language server for a file (e.g. "typescript"), as opposed to a
 * cross-cutting auxiliary scanner attached via clientScope "all"/
 * "with-auxiliary" (ast-grep, opengrep, zizmor, typos, marksman, ...). `role`
 * is only ever set to "auxiliary" on those auxiliary entries (see
 * clients/lsp/server.ts) — undefined means a real language server. Used to
 * split a file's diagnostics into "primary confirmation" vs "auxiliary
 * findings" so a page of ast-grep/opengrep/marksman noise never buries
 * whether the actual type checker/compiler confirmed the file clean.
 *
 * #646: extracted from `tools/lsp-diagnostics.ts` (where it originated) so
 * `tools/lens-diagnostics.ts`'s `mode=full` sweep can share the exact same
 * primary/auxiliary classification instead of hand-copying it — both tools
 * now report the same primary-vs-auxiliary split for the same file.
 */
export function primaryServerId(filePath: string): string | undefined {
	return getServersForFileWithConfig(filePath).find(
		(s) => s.role !== "auxiliary",
	)?.id;
}

/**
 * Look up an initializationOptions override for a built-in server.
 * Returns undefined when no config was loaded or no override was specified
 * for this server ID.
 *
 * @param serverId  Built-in server id (e.g. "rust", "nix", "bash")
 * @param filePath  Any file path within the project (used to locate the
 *                  workspace config that was loaded for this directory tree)
 */
export function getServerInitOverride(
	serverId: string,
	filePath: string,
): ServerInitOverride | undefined {
	return getConfigForFile(filePath).serverOverrides.get(serverId);
}

export function resetLSPConfigStateForTests(): void {
	workspaceConfigs.clear();
	resetLSPCaseSensitivityState();
	// Reset both together: a cleared config store beside a live session-root
	// registry would decline files for roots nothing can serve any more.
	resetSessionRootsForTests();
	// The warn latch is loader state too: a test that re-reads the same broken
	// path after this reset must see the warning again, not a latched silence.
	resetLSPConfigWarnCache();
}

/**
 * Test hook — read the `initLSPConfig` in-flight map directly (#1968's ABA
 * regression: a second writer replacing an entry mid-flight, then a
 * late-settling first run evicting it with a bare delete-by-key).
 */
export function _peekConfigInFlightForTests(): Map<string, Promise<void>> {
	return configInFlight;
}

// Re-export with config support
export { getAllServers as getServersForFile };
