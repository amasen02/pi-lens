/**
 * ktfmt Gradle-plugin style carriage (#2468).
 *
 * The `com.ncorti.ktfmt.gradle` plugin's top-level `ktfmt { }` extension
 * block lets a project select `googleStyle()` or `kotlinLangStyle()`
 * (verified against `KtfmtExtension.kt` on the plugin's `main` branch,
 * `cortinico/ktfmt-gradle`, 2026-09 — `googleStyle()`/`kotlinLangStyle()` are
 * the only two style functions it defines today). A THIRD function,
 * `dropboxStyle()`, existed in older plugin releases but was REMOVED in
 * ktfmt-gradle 0.19.0 (2024-07-03) because ktfmt itself dropped Dropbox-style
 * support (`CHANGELOG.md`: "Remove dropboxStyle since it is no longer
 * supported by ktfmt. Use kotlinLangStyle() instead") — a project whose
 * `build.gradle(.kts)` still calls it is on either a stale plugin or a
 * malformed manual block, and this module treats it as an unsupported style
 * (logged, falls back), never guessing a flag for it.
 *
 * None of this is read by ktfmt's own CLI from `build.gradle` — verified
 * against `ParsedArgs.kt` in `facebook/ktfmt` (now mirrored at
 * `Kotlin/ktfmt`) at tag v0.63, the exact version `clients/installer/
 * index.ts` pins for pi-lens's managed ktfmt install. That CLI accepts
 * `--google-style` / `--kotlinlang-style` (plus the default `--meta-style`)
 * and NO `--dropbox-style` flag at all — so the Gradle-declared choice has to
 * be translated to the matching CLI flag by something on our side; ktfmt
 * itself never bridges `build.gradle` to argv.
 *
 * Reuses the exact lexical pre-pass (`stripGradleCommentsAndStrings` /
 * `namedGradleBlockBodies`) that `clients/tool-policy.ts`'s
 * `getSpotlessKotlinFormatter` already applies to Gradle files, instead of a
 * second hand-rolled Gradle-block parser (#2468 AC) — same
 * single-source-of-truth reuse `clients/cargo-manifest.ts` did for TOML
 * parsing in `clients/formatters.ts`'s rustfmt `--edition` carriage (#2466).
 */

import * as os from "node:os";
import * as path from "node:path";
import { readTextFileOrUndefined } from "./cargo-manifest.js";
import { logExtension } from "./extension-log.js";
import { findNearestMarkerRoot } from "./path-utils.js";
import {
	namedGradleBlockBodies,
	stripGradleCommentsAndStrings,
} from "./tool-policy.js";

/** Nearest-first: a Kotlin script build file wins over its Groovy sibling. */
const KTFMT_GRADLE_ROOT_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

type KtfmtGradleStyle = "google" | "kotlinlang";

/** The CLI flags ktfmt v0.63 actually defines (`ParsedArgs.kt`, verified above). */
const KTFMT_STYLE_CLI_FLAG: Record<KtfmtGradleStyle, string> = {
	google: "--google-style",
	kotlinlang: "--kotlinlang-style",
};

/**
 * Read the style declared by a single `ktfmt { }` block body. `undefined`
 * means the block exists but declares no recognized style call (plugin
 * defaults apply); `"dropbox-unsupported"` flags the removed `dropboxStyle()`
 * call so the caller can log and fall back instead of guessing a flag.
 */
function styleFromKtfmtBlockBody(
	body: string,
): KtfmtGradleStyle | "dropbox-unsupported" | undefined {
	if (/\bgoogleStyle\s*\(\s*\)/.test(body)) return "google";
	if (/\bkotlinLangStyle\s*\(\s*\)/.test(body)) return "kotlinlang";
	if (/\bdropboxStyle\s*\(\s*\)/.test(body)) return "dropbox-unsupported";
	return undefined;
}

function styleFromGradleContent(
	content: string,
): KtfmtGradleStyle | "dropbox-unsupported" | undefined {
	const stripped = stripGradleCommentsAndStrings(content);
	for (const body of namedGradleBlockBodies(stripped, "ktfmt")) {
		const style = styleFromKtfmtBlockBody(body);
		if (style) return style;
	}
	return undefined;
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
 *   walk-confinement; never a private walk-up loop).
 * - Checks that directory's gradle files, `build.gradle.kts` first, for a
 *   `ktfmt { }` block declaring `googleStyle()` or `kotlinLangStyle()`.
 * - A nested module's OWN `ktfmt { }` block always wins over an ancestor's —
 *   the walk stops at the FIRST directory with a gradle file, so a
 *   root-level style selection never overrides a closer, more specific one.
 * - `dropboxStyle()` (removed from ktfmt-gradle 0.19.0+, and never a ktfmt
 *   CLI flag) is a recognized-but-unsupported selection: logged and treated
 *   as "no usable style", not passed through as a guessed flag.
 * - Returns `undefined` on any miss (no gradle file found, no `ktfmt { }`
 *   block, no recognized style call, or an unsupported one): callers fall
 *   back to their pre-existing default argv rather than guessing.
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
	const startDir = path.dirname(path.resolve(filePath));
	const gradleDir = findNearestMarkerRoot(startDir, KTFMT_GRADLE_ROOT_FILES, {
		homeDir,
	});
	if (!gradleDir) return undefined;

	for (const gradleFile of KTFMT_GRADLE_ROOT_FILES) {
		const gradlePath = path.join(gradleDir, gradleFile);
		const content = await readTextFileOrUndefined(gradlePath);
		if (content === undefined) continue;

		const style = styleFromGradleContent(content);
		if (style === "dropbox-unsupported") {
			logExtension({
				subsystem: "format",
				message:
					"resolveKtfmtGradleStyle: ktfmt { } block declares dropboxStyle(), " +
					"which ktfmt-gradle removed in 0.19.0 and ktfmt's own CLI never " +
					"exposed as a flag; falling back to the static ktfmt command",
				level: "debug",
				metadata: { filePath, gradlePath },
			});
			return undefined;
		}
		if (style) return KTFMT_STYLE_CLI_FLAG[style];
	}
	return undefined;
}
