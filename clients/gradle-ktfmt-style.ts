/**
 * ktfmt Gradle-plugin style carriage (#2468).
 *
 * The `com.ncorti.ktfmt.gradle` plugin's `ktfmt { }` extension block lets a
 * project select `googleStyle()` or `kotlinLangStyle()` (verified against
 * `KtfmtExtension.kt` in `cortinico/ktfmt-gradle` at
 * `23bdedc8d5d641731a0cf128f1a386d5a127ce4e` — those two are the only style
 * functions it defines today, and both are plain setters over
 * `blockIndent`/`continuationIndent`/`trailingCommaManagementStrategy`, so a
 * body calling both is LAST-CALL-WINS, not first).
 *
 * None of this is read by ktfmt's own CLI from `build.gradle` — verified
 * against `ParsedArgs.kt` in `facebook/ktfmt` (now mirrored at
 * `Kotlin/ktfmt`) at tag v0.63, the exact version `clients/installer/
 * index.ts` pins for pi-lens's managed ktfmt install. That CLI accepts
 * `--google-style` / `--kotlinlang-style` (plus the default `--meta-style`)
 * — so the Gradle-declared choice has to be translated to the matching CLI
 * flag by something on our side; ktfmt itself never bridges `build.gradle`
 * to argv.
 *
 * Reuses the exact lexical pre-pass (`stripGradleCommentsAndStrings` /
 * `namedGradleBlockRanges`) that `clients/tool-policy.ts`'s
 * `getSpotlessKotlinFormatter` already applies to Gradle files, instead of a
 * second hand-rolled Gradle-block parser (#2468 AC) — same
 * single-source-of-truth reuse `clients/cargo-manifest.ts` did for TOML
 * parsing in `clients/formatters.ts`'s rustfmt `--edition` carriage (#2466).
 *
 * ## Project scoping (#2468 review rounds 2 and 3)
 *
 * A Gradle build file configures more than the directory it sits in, and the
 * multi-module layout the plugin is actually used in puts the style in the
 * ROOT build file while each module's own `build.gradle(.kts)` declares only
 * its plugins. Round 1 stopped the ancestor climb at the first directory
 * holding ANY gradle file and matched `ktfmt {` anywhere in it, which was
 * wrong in both directions: a module inherited nothing (the #2468 defect
 * survived for the common layout) while the ROOT's own sources were handed a
 * `subprojects { }`-scoped style that Gradle never applies to them. This
 * module therefore classifies each `ktfmt { }` block by the block ENCLOSING
 * it — the actual brace nesting on the stripped source, not a single
 * hard-coded name test — and climbs past directories that declare no style
 * for the project being formatted:
 *
 * - no enclosing block (a top-level `ktfmt { }`) → the DECLARING directory
 *   only. Gradle does not inherit here: the plugin gives each project its own
 *   `KtfmtExtension` instance seeded with the plugin conventions (verified at
 *   the SHA above), so a module that applies the plugin and calls no style
 *   function really does format under ktfmt's default — which is exactly the
 *   bare invocation this resolver falls back to. Round 2 spread a top-level
 *   block over style-less descendants as a documented heuristic; that
 *   manufactured a NEW pi-lens/Gradle disagreement (pi-lens writes
 *   `--google-style`, `./gradlew ktfmtCheck` then rejects the file pi-lens
 *   just formatted) which the pre-#2468 bare invocation did not have, so it
 *   is gone. Aligning with `hasKtfmtConfig`'s wider climb does not justify
 *   it: that election answers "is ktfmt the formatter for this file", not
 *   "which style"; where Gradle carries no style down, the bare invocation IS
 *   the correct carriage of `--meta-style`.
 * - `subprojects { ktfmt { … } }` → DESCENDANT directories only, never the
 *   declaring one. `subprojects` configures the children and nothing else.
 * - `allprojects { ktfmt { … } }` → the declaring directory AND descendants.
 * - anything else enclosing it — `configure(subprojects.filter { … }) { }`,
 *   `project(":app") { }`, `tasks.register(…) { }`, a convention-plugin
 *   wrapper, or more than one nested block — reaches NEITHER scope. pi-lens
 *   cannot evaluate a build script, so a scope it cannot compute fails closed
 *   to the bare invocation rather than being granted to every project.
 *
 * KNOWN GAP (#2468 review round 3, F3): the first gradle directory found by
 * the climb is treated as the project that OWNS the file. A module directory
 * that is `include(…)`d by `settings.gradle(.kts)` but holds NO build file of
 * its own therefore resolves hop 0 to an ANCESTOR, and asks it for `own`
 * scope when `descendants` is what Gradle would apply — so a root
 * `subprojects { ktfmt { … } }` is missed for such a module. Closing it means
 * reading `settings.gradle`'s `include(…)` list to map a directory to a
 * Gradle project, which this module does not do. The miss is fail-safe: the
 * result is the pre-#2468 bare invocation, never a wrong flag.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readTextFileOrUndefined } from "./cargo-manifest.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import {
	gradleBlockRanges,
	type NamedGradleBlockRange,
	stripGradleCommentsAndStrings,
} from "./tool-policy.js";

/** Nearest-first: a Kotlin script build file wins over its Groovy sibling. */
const KTFMT_GRADLE_ROOT_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

/**
 * Ancestor gradle directories consulted before giving up. Each hop costs at
 * most four small reads, and Gradle builds nest a handful of levels at most;
 * the cap keeps a pathological tree (or a symlink cycle that survives
 * `path.dirname`) from turning one format into an unbounded walk. The
 * `homeDir` ceiling inside `findNearestMarkerRoot` normally ends the climb
 * long before this.
 */
const MAX_GRADLE_ANCESTOR_HOPS = 16;

type KtfmtGradleStyle = "google" | "kotlinlang";

/** The CLI flags ktfmt v0.63 actually defines (`ParsedArgs.kt`, verified above). */
const KTFMT_STYLE_CLI_FLAG: Record<KtfmtGradleStyle, string> = {
	google: "--google-style",
	kotlinlang: "--kotlinlang-style",
};

/**
 * The style a single gradle file declares, split by which projects it reaches.
 * `own` is the project whose directory holds the file; `descendants` is every
 * project below it.
 */
interface GradleKtfmtStyles {
	own?: KtfmtGradleStyle;
	descendants?: KtfmtGradleStyle;
}

/**
 * Read the style declared by one `ktfmt { }` block body, LAST call wins.
 *
 * `googleStyle()` and `kotlinLangStyle()` both just `.set(...)` the same
 * three extension properties, so in `ktfmt { googleStyle(); kotlinLangStyle() }`
 * the second call is the one whose values survive into the format (verified
 * against `KtfmtExtension.kt`, SHA above). `undefined` means the block
 * declares no recognized style call — including the `dropboxStyle()` that
 * ktfmt-gradle removed in 0.19.0 and ktfmt's CLI never exposed a flag for,
 * which is simply not a style this resolver can carry.
 */
function styleFromKtfmtBlockBody(body: string): KtfmtGradleStyle | undefined {
	let style: KtfmtGradleStyle | undefined;
	let lastIndex = -1;
	for (const [call, candidate] of [
		[/\bgoogleStyle\s*\(\s*\)/g, "google"],
		[/\bkotlinLangStyle\s*\(\s*\)/g, "kotlinlang"],
	] as const) {
		for (const match of body.matchAll(call)) {
			if (match.index > lastIndex) {
				lastIndex = match.index;
				style = candidate;
			}
		}
	}
	return style;
}

/**
 * Which projects a `ktfmt { }` block reaches. `undefined` from
 * `scopeOfKtfmtBlock` means NEITHER — a scope this resolver cannot compute,
 * which falls back to the bare invocation.
 */
type KtfmtBlockScope = "own" | "descendants" | "both";

/**
 * The Gradle blocks whose scope is exactly expressible here. Every other
 * enclosing block — including one we simply have not heard of — is a scope
 * pi-lens cannot evaluate, and is NOT silently promoted to project-wide.
 */
const SCOPE_BY_ENCLOSING_BLOCK: Readonly<Record<string, KtfmtBlockScope>> = {
	subprojects: "descendants",
	allprojects: "both",
};

/**
 * Classify one `ktfmt { }` block by the block that encloses it.
 *
 * `blocks` is every brace pair in the stripped source, so "enclosing" is
 * literal containment, not a guess from a name test: `range` strictly inside
 * `outer` means `outer.start < range.start` (an enclosing body always opens
 * before the body it contains) and `outer.end >= range.end`.
 *
 * More than one enclosing block (`subprojects { afterEvaluate { ktfmt { } } }`)
 * fails closed too. Composing scopes through an arbitrary intermediate is
 * exactly the kind of build-script evaluation this lexical pass cannot do,
 * and the cost of the conservative answer is the pre-#2468 bare invocation.
 */
function scopeOfKtfmtBlock(
	range: NamedGradleBlockRange,
	blocks: readonly NamedGradleBlockRange[],
): KtfmtBlockScope | undefined {
	const enclosing = blocks.filter(
		(outer) => outer.start < range.start && outer.end >= range.end,
	);
	if (enclosing.length === 0) return "own";
	if (enclosing.length > 1) return undefined;
	return SCOPE_BY_ENCLOSING_BLOCK[enclosing[0].name];
}

function stylesFromGradleContent(content: string): GradleKtfmtStyles {
	const stripped = stripGradleCommentsAndStrings(content);
	const blocks = gradleBlockRanges(stripped);
	const styles: GradleKtfmtStyles = {};
	// Source order, so a later block overwrites an earlier one for the scope
	// it reaches — the same last-call-wins rule that applies inside one body.
	// Each scope is written independently: two blocks that reach DISJOINT sets
	// of projects (a `subprojects { }` one and a top-level one) must not fight
	// over a single slot, or the source order of unrelated scopes decides
	// which project gets the wrong flag.
	for (const range of blocks) {
		if (range.name !== "ktfmt") continue;
		const scope = scopeOfKtfmtBlock(range, blocks);
		if (!scope) continue;
		const style = styleFromKtfmtBlockBody(
			stripped.slice(range.start, range.end),
		);
		if (!style) continue;
		if (scope !== "descendants") styles.own = style;
		if (scope !== "own") styles.descendants = style;
	}
	return styles;
}

async function stylesForGradleDir(
	gradleDir: string,
): Promise<GradleKtfmtStyles> {
	for (const gradleFile of KTFMT_GRADLE_ROOT_FILES) {
		const content = await readTextFileOrUndefined(
			path.join(gradleDir, gradleFile),
		);
		if (content === undefined) continue;
		const styles = stylesFromGradleContent(content);
		if (styles.own || styles.descendants) return styles;
	}
	return {};
}

/**
 * Resolve the ktfmt CLI style flag (`--google-style` / `--kotlinlang-style`)
 * for the Gradle project that owns `filePath`, so a caller that needs it
 * doesn't have ktfmt silently apply its own default style
 * (`--meta-style`-equivalent) where the project's `ktfmt { }` block picked a
 * different one (#2468 — the same manifest-detected-but-not-carried defect
 * shape #2466 fixed for rustfmt `--edition`).
 *
 * - Finds the nearest directory containing a `build.gradle(.kts)`/
 *   `settings.gradle(.kts)` file via the shared `findNearestMarkerRoot`
 *   walker (home-ceiling guarded, depth-capped — AGENTS.md
 *   walk-confinement; never a private walk-up loop). That first directory is
 *   TAKEN to be the project that OWNS the file, so its `own`-scope
 *   declaration applies; every further hop is an ancestor, so only its
 *   `descendants`-scope declaration does. See the module header's KNOWN GAP
 *   note for the `include(…)`-only module directory where that identification
 *   is wrong (fail-safe: a missed flag, never a wrong one).
 * - A nested module's OWN style declaration still wins over an ancestor's —
 *   the climb only continues past a gradle directory that declares NO style
 *   applying to this file, so nearest-wins is unchanged where a nearer
 *   declaration exists.
 * - Returns `undefined` on any miss (no gradle file found, no `ktfmt { }`
 *   block, or no recognized style call in one): callers fall back to their
 *   pre-existing default argv rather than guessing. `dropboxStyle()` — the
 *   call ktfmt-gradle removed in 0.19.0, never a ktfmt CLI flag — is just
 *   such a miss and never becomes a guessed flag.
 *
 * `homeDir` defaults to `os.homedir()` and exists as a parameter so tests can
 * inject a nearer ceiling and prove the guard actually stops a climb (mirrors
 * `resolveCargoPackageEdition`'s `homeDir` parameter, #2466 review round 2,
 * F5) — production callers never pass it.
 */
export async function resolveKtfmtGradleStyle(
	filePath: string,
	homeDir: string = os.homedir(),
): Promise<string | undefined> {
	let searchDir = path.dirname(path.resolve(filePath));

	for (let hop = 0; hop < MAX_GRADLE_ANCESTOR_HOPS; hop += 1) {
		const gradleDir = findNearestMarkerRoot(
			searchDir,
			KTFMT_GRADLE_ROOT_FILES,
			{
				homeDir,
			},
		);
		if (!gradleDir) return undefined;

		const styles = await stylesForGradleDir(gradleDir);
		const style = hop === 0 ? styles.own : styles.descendants;
		if (style) return KTFMT_STYLE_CLI_FLAG[style];

		const parent = path.dirname(gradleDir);
		if (parent === gradleDir) return undefined;
		searchDir = parent;
	}
	return undefined;
}
