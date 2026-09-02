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
 * ## Project scoping (#2468 review round 2)
 *
 * A Gradle build file configures more than the directory it sits in, and the
 * multi-module layout the plugin is actually used in puts the style in the
 * ROOT build file while each module's own `build.gradle(.kts)` declares only
 * its plugins. Round 1 stopped the ancestor climb at the first directory
 * holding ANY gradle file and matched `ktfmt {` anywhere in it, which was
 * wrong in both directions: a module inherited nothing (the #2468 defect
 * survived for the common layout) while the ROOT's own sources were handed a
 * `subprojects { }`-scoped style that Gradle never applies to them. This
 * module therefore classifies each `ktfmt { }` block by the block enclosing
 * it, and climbs past directories that declare no style for the project
 * being formatted:
 *
 * - `subprojects { ktfmt { … } }` → DESCENDANT directories only, never the
 *   declaring one. This half is exact: `subprojects` configures the children
 *   and nothing else.
 * - `allprojects { ktfmt { … } }` → the declaring directory AND descendants.
 * - a top-level `ktfmt { }` → the declaring directory, and — as a documented
 *   HEURISTIC — descendants that declare no style of their own. Gradle
 *   itself does not inherit here: each project gets its own `KtfmtExtension`
 *   instance with the plugin's conventions (verified at the SHA above), so a
 *   module with the plugin applied but no style call really does format
 *   under the plugin default. pi-lens cannot evaluate a build script to tell
 *   those apart, and this is the same scope `hasKtfmtConfig` already uses to
 *   ELECT ktfmt for such a file (it climbs to the root and matches `ktfmt`
 *   anywhere): resolving the style over a narrower scope than the selection
 *   that got us here is precisely the detected-but-not-carried split #2468
 *   exists to close. The cost is bounded and one-directional — the only
 *   projects affected are ones whose ancestor picked a style explicitly.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readTextFileOrUndefined } from "./cargo-manifest.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import {
	type GradleBlockRange,
	namedGradleBlockRanges,
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

function isInsideAny(
	range: GradleBlockRange,
	enclosing: readonly GradleBlockRange[],
): boolean {
	return enclosing.some(
		(outer) => range.start >= outer.start && range.end <= outer.end,
	);
}

function stylesFromGradleContent(content: string): GradleKtfmtStyles {
	const stripped = stripGradleCommentsAndStrings(content);
	const subprojects = namedGradleBlockRanges(stripped, "subprojects");
	const styles: GradleKtfmtStyles = {};
	// Source order, so a later block overwrites an earlier one for the scope
	// it reaches — the same last-call-wins rule that applies inside one body.
	for (const range of namedGradleBlockRanges(stripped, "ktfmt")) {
		const style = styleFromKtfmtBlockBody(
			stripped.slice(range.start, range.end),
		);
		if (!style) continue;
		styles.descendants = style;
		// `subprojects { }` is the one enclosing form that excludes the
		// declaring project. Top-level and `allprojects { }` both reach it.
		if (!isInsideAny(range, subprojects)) styles.own = style;
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
 *   the project that OWNS the file, so its `own`-scope declaration applies;
 *   every further hop is an ancestor, so only its `descendants`-scope
 *   declaration does.
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
