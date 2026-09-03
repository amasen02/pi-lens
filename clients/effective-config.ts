/**
 * Effective-config introspection (#2427; the introspection addition to #2415).
 *
 * ONE query answers "why is X running / selected", which today costs log
 * forensics across `lsp/config.ts`, `language-policy.ts` and the trust state.
 * `LSPService.getCapabilitySnapshots` is the proven template: compute the
 * answer once in the engine, project it through every adapter unchanged.
 *
 * Three rules this module is built on, and none of them is negotiable at a
 * call site:
 *
 * 1. IT DECIDES NOTHING. Every answer is read back from the same production
 *    machinery the runtime uses — `resolvePiLensConfig` for the resolution,
 *    `explainServersForFile` for the LSP gates, `detectFileKind` +
 *    `getToolPlan` + `getAvailableRunners` for dispatch. A second evaluation
 *    that agreed with production today would disagree with it eventually, and
 *    an introspection surface that lies is worse than none.
 * 2. IT REPORTS NOTHING. `resolveConfig` is pure and `reportPiLensConfigRecords`
 *    is a separate, explicit step (`config-core/index.ts`) precisely so a
 *    caller decides when a user gets warned. Asking "what is my config" must
 *    not emit a deprecation notice, and must not consume the warn-once latch
 *    that the loader needs — so this module carries record CODES and counts,
 *    and never calls the reporter.
 * 3. THE REDACTED VIEW IS THE ONLY VIEW. There is no `redact: false`. Config
 *    file paths are rewritten home-relative, a custom server's argv is cut to
 *    `argv[0]`, and its environment is reduced to NAMES — the two places a
 *    secret actually lives (#2415 AC 4). The `redact` option exists only
 *    because the issue named it; it is `true` or absent, and both mean the
 *    same thing, so no future caller can spell an unredacted request.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	compareKeys,
	type Provenance,
	provenanceFor,
	type ProvenanceViewEntry,
	provenanceView,
	type Resolved,
	SOURCE_TIERS,
	type SourceTier,
} from "./config-core/provenance.js";
import { LSP_NAMESPACE_KEY } from "./config-locations.js";
import { lspSectionOf, resolvePiLensConfig } from "./config-resolve.js";
import { getToolPlan } from "./dispatch/plan.js";
import { getAvailableRunners } from "./dispatch/integration.js";
import { detectFileKind } from "./file-kinds.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { type LanguageEntry, resolveLanguage } from "./language-registry.js";
import { getPiLensGlobalConfigPath } from "./lens-config.js";
import {
	explainServersForFile,
	initLSPConfig,
	type ServerSelectionReason,
} from "./lsp/config.js";
import { homeRelativePath } from "./path-utils.js";

export interface EffectiveConfigOptions {
	/** Workspace the resolution is performed for. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Add the per-file selection view for this path. */
	readonly file?: string;
	/**
	 * Accepted and ignored. Redaction is unconditional; see rule 3 in the module
	 * doc. The option exists so a caller that spells it is not an error, not so
	 * that omitting it means anything.
	 */
	readonly redact?: true;
	/** `$HOME` used for home-relative rewriting. Test seam only. */
	readonly homeDir?: string;
}

/** One config document that contributed to the resolution. */
export interface EffectiveConfigDocument {
	readonly tier: SourceTier;
	/** Home-relative when the file is under `$HOME`. */
	readonly file: string;
	/** True for a location on a removal schedule (`DEPRECATED_CONFIG_SURFACES`). */
	readonly legacy: boolean;
}

/** A custom server's definition, reduced to what cannot carry a secret. */
export interface RedactedServerSpec {
	/** `argv[0]` only. */
	readonly command?: string;
	/** How many argv entries the definition carries, including `argv[0]`. */
	readonly argvCount: number;
	/** Env NAMES, sorted. Values never appear on this surface. */
	readonly envNames: readonly string[];
}

/** One server's answer for a file, with the reason and the tier that decided. */
export interface EffectiveServerDecision {
	readonly id: string;
	readonly selected: boolean;
	readonly reason: ServerSelectionReason;
	/** `"auxiliary"` for cross-cutting scanners; absent for language servers. */
	readonly role?: string;
	/** The provenance of the config leaf that produced a config-made decision. */
	readonly decidedBy?: ProvenanceViewEntry;
	/** Present only for a server defined by configuration. */
	readonly spec?: RedactedServerSpec;
}

/** Why a runner did or did not make a file's dispatch plan. */
export type ToolSelectionReason =
	| "selected"
	| "not-registered-for-kind"
	| "no-dispatch-plan";

export interface EffectiveToolDecision {
	readonly id: string;
	readonly selected: boolean;
	readonly reason: ToolSelectionReason;
}

/** The per-file half: language, servers, tools. */
export interface EffectiveFileView {
	/** Home-relative when the file is under `$HOME`. */
	readonly path: string;
	/** The canonical language id from `clients/language-registry.ts`. */
	readonly language?: string;
	/** The coarse dispatch kind, when `file-kinds.ts` classifies the file. */
	readonly kind?: string;
	readonly servers: readonly EffectiveServerDecision[];
	readonly tools: readonly EffectiveToolDecision[];
}

export interface EffectiveConfigView {
	/** Home-relative when the workspace is under `$HOME`. */
	readonly cwd: string;
	readonly documents: readonly EffectiveConfigDocument[];
	/** Every resolved leaf's source. Sources only, never values. */
	readonly provenance: readonly ProvenanceViewEntry[];
	/** How many leaves each tier decided. The shape `pilens_health` embeds. */
	readonly provenanceCounts: Readonly<Record<SourceTier, number>>;
	/** The stable `PILENS_CFG_*` codes this resolution produced, with counts. */
	readonly recordCounts: Readonly<Record<string, number>>;
	readonly file?: EffectiveFileView;
}

/** A zero for every tier, so a consumer never has to test for an absent key. */
function emptyTierCounts(): Record<SourceTier, number> {
	return Object.fromEntries(SOURCE_TIERS.map((tier) => [tier, 0])) as Record<
		SourceTier,
		number
	>;
}

function countBy<T>(items: readonly T[], key: (item: T) => string) {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const name = key(item);
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

/**
 * Redact a `lsp.servers.<id>` entry.
 *
 * Deliberately NOT `redactProcessSpec`: that takes a built `ProcessSpec`, and
 * a custom server is still the pre-#2416 bare `{ command, args, env }` shape.
 * The INVARIANT is the same one and is spelled the same way — `argv[0]` and
 * env NAMES survive, everything else does not — so when #2416 replaces the
 * shape this projection is deleted rather than adapted.
 */
function redactServerSpec(entry: unknown): RedactedServerSpec | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return undefined;
	}
	const record = entry as Record<string, unknown>;
	const command =
		typeof record.command === "string" ? record.command : undefined;
	const args = Array.isArray(record.args) ? record.args : [];
	const env =
		typeof record.env === "object" && record.env !== null
			? Object.keys(record.env as Record<string, unknown>).sort()
			: [];
	return {
		...(command === undefined ? {} : { command }),
		argvCount: (command === undefined ? 0 : 1) + args.length,
		envNames: env,
	};
}

/**
 * The provenance of a SUBTREE — the entry at the pointer, else the nearest
 * ancestor's, else the lowest-sorting leaf beneath it.
 *
 * `provenanceFor` walks UP only, and that is correct for its question: a leaf
 * asks who decided it. An object node asks the opposite question. `merge()`
 * records provenance at the leaves, so `lsp.servers.<id>` — an object — has no
 * entry of its own and no ancestor with one either, and asking `provenanceFor`
 * about it answers `undefined` for a section a file demonstrably contributed.
 * Descending settles it: the entry sorts deterministically (`compareKeys`), so
 * the same config produces the same attribution on every machine.
 */
function provenanceOfSubtree(
	resolved: Resolved<Record<string, unknown>>,
	pointer: string,
): Provenance | undefined {
	const own = provenanceFor(resolved, pointer);
	if (own) return own;
	const prefix = `${pointer}/`;
	let best: Provenance | undefined;
	for (const entry of resolved.provenance.values()) {
		if (!entry.key.startsWith(prefix)) continue;
		if (!best || compareKeys(entry.key, best.key) < 0) best = entry;
	}
	return best;
}

/**
 * The provenance entry governing a pointer, projected and home-relative.
 *
 * Goes through `provenanceFor`, which walks to the nearest ancestor — and for
 * a deny union that ancestry now MATTERS (#2427 review round 2, F2).
 * `merge()` records an entry at the array's own pointer AND one per surviving
 * member, so `/lsp/disabledServers/0` and `/lsp/disabledServers`
 * deliberately give DIFFERENT answers: the array names the tier that denied
 * first, the member names the tier that contributed that member. Round 1 of
 * this PR asserted they were the same, read the array entry for every server,
 * and reported a project-tier denial as a global one. Asking about a member
 * that has no entry of its own still falls back to the array, which is the
 * walk doing its job rather than an accident.
 */
function viewOf(
	entry: Provenance | undefined,
	homeDir: string | undefined,
): ProvenanceViewEntry | undefined {
	if (!entry) return undefined;
	return {
		key: entry.key,
		tier: entry.tier,
		...(entry.file === undefined
			? {}
			: { file: homeRelativePath(entry.file, homeDir) }),
		...(entry.trust === undefined ? {} : { trust: entry.trust }),
	};
}

/**
 * `{ decidedBy }`, or nothing when there is no provenance to report.
 *
 * A named helper because the alternative at the call site is a ternary inside a
 * spread inside a ternary, which is the nesting SonarCloud flags and a reader
 * has to unpick to learn one fact.
 */
function decidedByOrNothing(
	entry: ProvenanceViewEntry | undefined,
): { decidedBy?: ProvenanceViewEntry } {
	return entry === undefined ? {} : { decidedBy: entry };
}

/**
 * The resolved model of pi-lens's configuration, with the provenance of every
 * decision — and, for one file, which servers and tools that configuration
 * selects or denies and why.
 *
 * Async because the per-file half drives `initLSPConfig` first. That is not
 * incidental: the per-workspace disable set is materialized by `initLSPConfig`
 * and `getConfigForFile` falls back to an EMPTY config for an un-initialized
 * tree, so a view taken before it would report every server as selected — the
 * introspection surface confidently contradicting the runtime it describes.
 * `initLSPConfig` is idempotent and in-flight-deduplicated, so paying for it
 * costs nothing when a session already ran it.
 *
 * It runs ONLY when a `file` is asked about. The whole-config view is derived
 * from `resolvePiLensConfig` alone, and `pilens_health` takes exactly that
 * view on every call — initializing a workspace's LSP config as a side effect
 * of asking for a health line would be a query that changes the thing it
 * reports on.
 */
export async function effectiveConfig(
	options: EffectiveConfigOptions = {},
): Promise<EffectiveConfigView> {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();
	if (options.file !== undefined) await initLSPConfig(cwd);

	const resolution = resolvePiLensConfig({
		cwd,
		globalDir: getGlobalPiLensDir(),
		globalConfigPath: getPiLensGlobalConfigPath(homeDir),
		homeDir,
		// No `onReadError`: see rule 2. An unreadable file still shows up as a
		// `PILENS_CFG_0001` record count below, so the answer is not silent — it
		// just is not a second user-facing warning fired by a question.
	});
	const resolved = {
		value: resolution.value,
		provenance: resolution.provenance,
	};

	const counts = emptyTierCounts();
	for (const entry of resolution.provenance.values()) counts[entry.tier] += 1;

	const view: EffectiveConfigView = {
		cwd: homeRelativePath(cwd, homeDir),
		documents: resolution.documents.map((document) => ({
			tier: document.tier,
			file: homeRelativePath(document.file, homeDir),
			legacy: document.location.legacy,
		})),
		provenance: provenanceView(resolved, homeDir).entries,
		provenanceCounts: counts,
		recordCounts: countBy(resolution.records, (record) => record.code),
		...(options.file === undefined
			? {}
			: {
					// Relative to the WORKSPACE, not to `process.cwd()`. A caller that
					// names a workspace and then a file inside it means that file; a
					// bare `path.resolve` would silently answer for a same-named path
					// under the host process's own directory, which is a wrong answer
					// wearing a confident shape.
					file: await fileView(
						path.resolve(cwd, options.file),
						resolved,
						homeDir,
					),
				}),
	};
	return view;
}

async function fileView(
	absolute: string,
	resolved: Resolved<Record<string, unknown>>,
	homeDir: string,
): Promise<EffectiveFileView> {
	const language: LanguageEntry | undefined = resolveLanguage(absolute);
	const kind = detectFileKind(absolute);
	const section = lspSectionOf(resolved.value);
	const customServers =
		typeof section.servers === "object" &&
		section.servers !== null &&
		!Array.isArray(section.servers)
			? (section.servers as Record<string, unknown>)
			: {};

	// The provenance that answers "why can I not turn THIS one back on".
	//
	// Per MEMBER, not per array (#2427 review round 2, F2). The union is
	// assembled from several tiers, so the array's own entry names only the tier
	// that denied FIRST; stamping it on every disabled server reported a
	// project-tier denial as a global one. `merge()` records an entry at each
	// member's pointer, so the answer is a lookup at the member's index in the
	// resolved list.
	//
	// The legacy root spelling is no longer a fallback: `resolvePiLensConfig`
	// normalizes it into the namespace at source injection, so `/disabledServers`
	// is not a pointer any resolution produces any more (F1).
	const denied = Array.isArray(section.disabledServers)
		? (section.disabledServers as unknown[])
		: [];
	const denyPointer = `/${LSP_NAMESPACE_KEY}/disabledServers`;
	const decidedByDeny = (id: string): ProvenanceViewEntry | undefined => {
		const index = denied.indexOf(id);
		// `provenanceFor` walks UP, so a member with no entry of its own still
		// answers with the array's — the right degradation, not a silent gap.
		return viewOf(
			provenanceFor(
				resolved,
				index >= 0 ? `${denyPointer}/${index}` : denyPointer,
			),
			homeDir,
		);
	};

	const servers: EffectiveServerDecision[] = explainServersForFile(
		absolute,
	).map((entry) => {
		const spec = redactServerSpec(customServers[entry.server.id]);
		return {
			id: entry.server.id,
			selected: entry.selected,
			reason: entry.reason,
			...(entry.server.role === undefined ? {} : { role: entry.server.role }),
			...(entry.reason === "disabled-by-config"
				? decidedByOrNothing(decidedByDeny(entry.server.id))
				: {}),
			...(spec === undefined
				? {}
				: {
						spec,
						...(entry.reason === "disabled-by-config"
							? {}
							: {
									decidedBy: viewOf(
										provenanceOfSubtree(
											resolved,
											`/${LSP_NAMESPACE_KEY}/servers/${entry.server.id}`,
										) ??
											provenanceOfSubtree(
												resolved,
												`/servers/${entry.server.id}`,
											),
										homeDir,
									),
								}),
					}),
		};
	});

	const available = new Set(await getAvailableRunners(absolute));
	const planned = kind
		? (getToolPlan(kind)?.groups.flatMap((group) => group.runnerIds) ?? [])
		: [];
	const ids = [...new Set([...planned, ...available])].sort();
	const tools: EffectiveToolDecision[] = ids.map((id) => ({
		id,
		selected: available.has(id),
		reason: available.has(id)
			? "selected"
			: kind === undefined
				? "no-dispatch-plan"
				: "not-registered-for-kind",
	}));

	return {
		path: homeRelativePath(absolute, homeDir),
		...(language === undefined ? {} : { language: language.id }),
		...(kind === undefined ? {} : { kind }),
		servers,
		tools,
	};
}
