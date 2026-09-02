/**
 * Shared file path utilities for pi-lens
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Minimatch, type MinimatchOptions } from "./deps/minimatch.js";
import { isTestMode } from "./env-utils.js";
import {
	isInSpawnTimeoutCooldown,
	noteSpawnTimeout,
} from "./spawn-timeout-cooldown.js";
import {
	collectTrackedFiles,
	getTrackedFilesSnapshot,
} from "./git-tracked-ignore.js";
import {
	getGlobalIgnorePatterns,
	getPiLensGlobalConfigPath,
} from "./lens-config.js";
import {
	isExternalOrVendorFile,
	isUnderDir,
	normalizeEphemeralMapKey,
	normalizeFilePath,
} from "./path-utils.js";
import {
	findPiLensConfigInDir,
	findPiLensProjectConfig,
	loadPiLensConfigInDir,
	loadPiLensProjectConfig,
} from "./project-lens-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";

/**
 * Return the directory where pi-lens stores project-specific data
 * (caches, indexes, worklogs, etc.).
 *
 * Default: reuse <project>/.pi-lens if it already exists, otherwise use
 * ~/.pi-lens/projects/<project-slug>
 *
 * Override: set PILENS_DATA_DIR=/some/path — each project gets its own
 * subdirectory named after a sanitized form of its absolute path, e.g.
 *   PILENS_DATA_DIR=~/.pi-lens/projects
 *   → ~/.pi-lens/projects/home-user-myapp/
 *
 * This keeps project folders clean and avoids creating .pi-lens folders
 * inside user projects.
 */
export function getProjectDataDir(cwd: string): string {
	const legacyProjectDir = path.join(cwd, ".pi-lens");
	const configuredBase = process.env.PILENS_DATA_DIR?.trim();
	if (!configuredBase && fs.existsSync(legacyProjectDir)) {
		return legacyProjectDir;
	}
	const base = configuredBase || path.join(getGlobalPiLensDir(), "projects");
	const normalized = normalizeFilePath(path.resolve(cwd));
	const slug = normalized
		.replace(/^[a-z]:/i, "") // strip Windows drive letter
		.replace(/\/+/g, "-") // separators → dashes
		.replace(/[^A-Za-z0-9-]/g, "") // strip anything else
		.replace(/^-+/, "") // trim leading dashes
		.replace(/-+$/, ""); // trim trailing dashes
	return path.join(base.trim(), slug || "default");
}

/**
 * Machine-global pi-lens directory: `~/.pi-lens/` by default.
 *
 * Used for tool binaries (`~/.pi-lens/tools/`, `~/.pi-lens/bin/`), the
 * cross-process instance registry (`instances.json`, #449/#525) and the
 * orphan-backstop lease beside it, the auto-install probe cache, the
 * canonical global config (`config.json`), LSP server storage (intelephense's
 * index, PSES's per-PID session dir) and JVM runtimes — state that is
 * intentionally NOT project-scoped, because it spans every project pi-lens
 * has touched.
 *
 * Override: set `PI_LENS_HOME=/some/path` to relocate this ENTIRE root (every
 * caller routes through this one function, so one env var covers all of
 * them — see #525). Tests MUST set this to a per-worker temp dir in
 * `tests/support/vitest-setup.ts` rather than mocking each caller separately;
 * otherwise a test that exercises `registerInstance`/`sweepOrphans` or any
 * logger writes into the developer's REAL `~/.pi-lens` (dogfooded live: a
 * test-fixture instance survived in the real `instances.json` for 17h).
 *
 * DELIBERATELY cwd-INDEPENDENT (#2506 round 3). Its sibling
 * `getGlobalPiLensLogDir()` below carries the probe-home redirect; this one
 * must not, because the things resolved here are shared machine state a
 * session needs to KEEP: a pi session running from an agent worktree or a
 * throwaway temp project must still find the tools it already installed and
 * must still register in the one `instances.json` every other pi-lens process
 * on the box reads. Redirecting THIS function (as round 2 of #2506 did) would
 * silently give every worktree its own empty tool tree and its own private
 * registry, so the reaper could never see across them — a worse defect than
 * the telemetry pollution the redirect exists to stop.
 *
 * Distinct from `getProjectDataDir(cwd)`, which respects `PILENS_DATA_DIR`
 * (project-scoped) and produces per-project subdirectories. Callers writing
 * project caches, snapshots, or worklogs should use `getProjectDataDir(cwd)`
 * instead — `PI_LENS_HOME` is the MACHINE-scoped sibling of that override.
 * `getProjectDataDir` composes through THIS function, not the log one: a
 * probe's project caches are already isolated by its own path slug, and a
 * worktree session keeping its warm caches is the same "do not break the
 * session" argument as the tools above.
 */
export function getGlobalPiLensDir(): string {
	const override = process.env.PI_LENS_HOME?.trim();
	if (override) return path.resolve(override);
	return path.join(os.homedir(), ".pi-lens");
}

/**
 * Where pi-lens writes its LOGS, ledger rows and debug dumps: `~/.pi-lens/`
 * by default, exactly like `getGlobalPiLensDir()` above — but redirectable to
 * a per-probe directory when the process looks like an ad-hoc probe rather
 * than a real pi session (#2506).
 *
 * Every log-family writer routes here: `latency.log`, `extension.log`,
 * `sessionstart.log`, `cascade.log`, `read-guard.log`, `tree-sitter.log`,
 * `word-index.log`, `bus-events.log`, `dispositions.log`, `dead-code.log`,
 * `ast-grep-tools.log`, `actionable-warnings.log`, `review-graph.log`, the
 * `logs/*.jsonl` diagnostic dir, the debug handle/heap dumps,
 * `log-cleanup.ts`'s sweep over all of the above, and `smells-rollup.ts`'s
 * read-side tail of `latency.log`/`bus-events.log` (a reader, but it must
 * follow the same root or it tails a file nobody is writing).
 *
 * WHY the redirect exists: an ad-hoc probe against the BUILT `clients/*.js` —
 * a bare `node -e`, a throwaway `.mjs`, a harness script run OUTSIDE vitest —
 * has no test-mode gate and no `PI_LENS_HOME` pin, so every logger and ledger
 * it touches used to write into the maintainer's REAL `~/.pi-lens`. Confirmed
 * live on 2026-09-02: two review probes left 42 rows of `/p/.pi-lens.json`
 * fixture garbage in real telemetry. vitest itself is already hermetic
 * (`tests/support/vitest-setup.ts` pins `PI_LENS_HOME`); this guard is for
 * everything that runs outside it.
 *
 * WHEN it fires (see `computeProbeHomeDir` below): `PI_LENS_HOME` unset, and
 * either `PILENS_PROBE=1` (the explicit force, for a probe run from an
 * ordinary checkout) or — outside test mode — a `cwd` inside a specific agent
 * worktree (`.claude/worktrees/<worktree>/...`) or under `os.tmpdir()`. The
 * decision is made ONCE per process and memoized, so a `process.chdir()`
 * mid-run cannot scatter one process's logs across several roots (F5).
 *
 * Deliberately does NOT write a line to the terminal when it fires. #1333
 * gives pi sole ownership of the TTY, and
 * `tests/clients/extension-terminal-silence.test.ts` enforces that nothing
 * under `clients/` calls `process.std*.write` or `console.*` (round 2 of this
 * issue shipped a `process.stderr.write` here and was red in CI for exactly
 * that). Nor can it log through `extension-log.ts`'s `createSubsystemLogger`:
 * that module already imports THIS one (the `extension-log.ts` to
 * `file-utils.ts` edge is pinned in
 * `.dependency-cruiser-known-violations.json`), so an import back the other
 * way would close a new, unpinned `no-client-cycles` cycle — and
 * `extension.log` is itself redirected by this very function, so the line
 * would land in the probe home nobody reads. The durable signal is the
 * `global-dir-probe-redirect` degradation row instead, recorded once per
 * process through the zero-import `probe-home-state.ts` leaf and folded into
 * `getDegradationSummary()` at read time.
 */
export function getGlobalPiLensLogDir(): string {
	const override = process.env.PI_LENS_HOME?.trim();
	if (override) return path.resolve(override);
	return resolveProbeHomeDirOnce() ?? path.join(os.homedir(), ".pi-lens");
}

/**
 * Resolve the probe-home redirect at most ONCE per process, caching both the
 * "yes, here" and the "no redirect" answers in the `probe-home-state.ts` leaf
 * (#2506 round 3, F5). Round 2 read `process.cwd()` live on every call, which
 * gave a single process up to three different global dirs as it chdir'd, and
 * re-ran the whole decision on the hot logging path.
 *
 * The cache lives in the leaf rather than here so that ONE reset
 * (`_resetProbeHomeRedirectStateForTests`) clears the memo and the recorded
 * event together — they are one fact, and a reset clearing only one of them
 * would leave the pair inconsistent (F6).
 */
/**
 * The shape stored in the shared `globalThis` slot. The canonical definition
 * (and the ledger-facing reader plus the test reset) lives in
 * `clients/probe-home-state.ts`; it is restated structurally here because
 * this module must not IMPORT that one — see the note inside the function.
 */
interface ProbeHomeResolutionSlot {
	probeHome: string | undefined;
	event: { probeHome: string; cwd: string } | undefined;
}

function resolveProbeHomeDirOnce(): string | undefined {
	// Storage is a `globalThis` slot keyed by a string that THIS module and
	// `probe-home-state.ts` each name as a literal. `file-utils.ts`
	// deliberately does not import that module, even though it is a zero-import
	// leaf: `log-cleanup.ts` calls `getGlobalPiLensLogDir()` at its OWN module
	// top level, reaching this function through the pre-existing cycle while
	// `file-utils.ts`'s module record is still mid-init — and at that moment an
	// import BINDING is not yet initialized either, so dereferencing one throws
	// `ReferenceError: Cannot access '...' before initialization` (caught live
	// TWICE on this issue: once as a module-scope `const`, once as this very
	// import). A `Symbol.for` property access is process-wide interned by
	// string and has no such window.
	//
	// `tests/config/global-dir-probe-redirect.test.ts` pins the two literals
	// equal, so the deliberate duplication cannot drift into two silent slots.
	const slot = globalThis as typeof globalThis &
		Record<symbol, ProbeHomeResolutionSlot | undefined>;
	const key = Symbol.for("pi-lens.probe-home-state.resolution");
	const cached = slot[key];
	if (cached) return cached.probeHome;
	const cwd = process.cwd();
	const probeHome = computeProbeHomeDir(cwd);
	slot[key] = { probeHome, event: probeHome ? { probeHome, cwd } : undefined };
	return probeHome;
}

/**
 * The redirect decision itself. Note every string below is an inline literal
 * and there is no module-scope `const`/`let` anywhere in this family:
 * `file-utils.ts` sits on a pre-existing import cycle (`file-utils.js` to
 * `safe-spawn.js` to `degradation-ledger.js` to `extension-log.js` and back
 * to `file-utils.js`, plus `log-cleanup.js` to `file-utils.js`), and
 * `log-cleanup.ts` calls into this file at its OWN module top level — so this
 * function can run while `file-utils.ts`'s module body is still mid-init,
 * when any binding declared below it would still be in the TDZ and throw
 * `ReferenceError` (caught live in round 2).
 */
function computeProbeHomeDir(cwd: string): string | undefined {
	// The explicit force wins first: it is how a probe run from an ordinary
	// project checkout opts in, and it must work even under a harness that has
	// set a test-mode marker but no PI_LENS_HOME.
	if (process.env.PILENS_PROBE === "1") {
		return path.join(cwd, ".pi-lens-probe-home");
	}
	if (isTestMode()) return undefined;
	const worktreeRoot = findAgentWorktreeRoot(cwd);
	if (worktreeRoot) return path.join(worktreeRoot, ".pi-lens-probe-home");
	if (isUnderRealDir(cwd, os.tmpdir())) {
		return path.join(cwd, ".pi-lens-probe-home");
	}
	return undefined;
}

/**
 * The directory of the SPECIFIC agent worktree containing `cwd`, or
 * `undefined` when `cwd` is not inside one.
 *
 * Requires at least one path segment AFTER `worktrees/`, and anchors the
 * probe home at that segment rather than at the live `cwd` (#2506 round 3,
 * F5). Round 2's trailing `(\/|$)` alternative also matched a `cwd` of
 * `.claude/worktrees` ITSELF, which would have put the probe home in the
 * SHARED worktrees parent — every concurrent agent on the box writing into
 * one directory, the cross-agent collision this redirect is supposed to
 * prevent. Anchoring at the worktree also means a probe run from a
 * subdirectory (`<worktree>/clients`) and one run from the worktree root
 * agree on a single probe home instead of scattering one per cwd.
 */
function findAgentWorktreeRoot(cwd: string): string | undefined {
	const normalized = normalizeFilePath(path.resolve(cwd));
	const match = /(?:^|\/)\.claude\/worktrees\/[^/]+(?:\/|$)/.exec(normalized);
	if (!match) return undefined;
	return normalized.slice(0, match.index + match[0].length).replace(/\/$/, "");
}

/**
 * `isUnderDir`, but with both sides resolved through `realpath` first
 * (#2506 round 3, F7).
 *
 * On macOS `os.tmpdir()` reports `/var/folders/...` while a `cwd` created
 * under it resolves to `/private/var/folders/...` (`/var` is a symlink to
 * `/private/var`), so the two NEVER prefix-match unresolved and the tmpdir
 * branch would be dead on every Mac. Windows has the same shape with 8.3
 * short names and substituted drives. Both sides go through the same
 * function, so `realpathSync.native`'s canonical Windows casing applies
 * consistently; the result is used only for this containment test, never to
 * build the returned path, so no casing change can leak into a log path.
 * Best-effort by design: a path that does not exist yet (or an EPERM) falls
 * back to its literal form rather than throwing on the logging hot path.
 */
function isUnderRealDir(child: string, parent: string): boolean {
	return isUnderDir(toRealPath(child), toRealPath(parent));
}

function toRealPath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return target;
	}
}

/**
 * Directories to exclude from all scans (build outputs, dependencies, caches).
 * Used consistently across all scanners to avoid noise from generated files.
 */
export const EXCLUDED_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	".turbo",
	".cache",
	"target",
	"out",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".yarn",
	".pnpm-store",
	".gradle",
	".next",
	".pi-lens",
	".pi", // pi agent directory
	".ruff_cache", // Python linter cache
	".worktrees",
	".claude",
	".codex",
	".rescue",
	".agents",
	".gstack",
	".superpowers",
	".guardrails",
	".playwright-cli",
	".playwright-mcp",
	".vscode",
	"venv",
	".venv",
	"coverage",
	"__pycache__",
	".tox",
	".pytest_cache",
	"*.dSYM",
	// Vendored upstream source conventions — universally too large to scan
	"vendor", // Go modules, PHP Composer, Ruby Bundler
	"third_party", // Chromium/Google convention (llama.cpp, sherpa-onnx, gRPC, TF)
	"third-party",
	"vendors",
];

/**
 * Which layer produced a pattern, per #703's layer-semantics fix. Precedence
 * (lowest → highest) is `global` → `gitignore` → `pilens` — see
 * `createProjectIgnoreMatcher`'s ordering comment. The layer determines
 * whether a winning positive match is subject to git's "a tracked file is
 * never ignored" rule:
 *   - `global` / `gitignore` emulate git itself, so they inherit that rule —
 *     a winning match from either NEVER excludes a file git tracks.
 *   - `pilens` (`.pi-lens.json`'s `ignore` field) is pi-lens-native user
 *     intent ("don't analyze this"), not a git emulation, so it excludes
 *     regardless of tracked status.
 *
 * `pilens` patterns can come from the root `.pi-lens.json` (loaded once at
 * matcher-construction time in `createProjectIgnoreMatcher`) OR from a
 * package-local `.pi-lens.json` layered in per ancestor directory by
 * `buildProjectIgnoreMatcher`'s `patternsForDir` (#783) — both are tagged
 * `"pilens"` and share the same tracked-file-rescue exemption.
 */
export type GitignorePatternLayer = "global" | "gitignore" | "pilens";

export interface GitignorePattern {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	rooted: boolean;
	hasSlash: boolean;
	layer: GitignorePatternLayer;
}

export interface ProjectIgnoreMatcher {
	rootDir: string;
	patterns: GitignorePattern[];
	/** Drops path verdicts below a changed nested `.gitignore`. */
	invalidateSubtree(subtree: string): void;
	isIgnored(filePath: string, isDirectory?: boolean): boolean;
	/**
	 * Primes the tracked-files set for `rootDir` (async `git ls-files`,
	 * memoized — see `git-tracked-ignore.ts`) so subsequent synchronous
	 * `isIgnored` calls in the SAME walk can honor #703's tracked-aware
	 * layer semantics. Callers with an async walk loop should await this
	 * ONCE before the loop starts, not per file. Fail-open: resolves even
	 * when git is absent/fails/times out (tracked-check then silently stays
	 * unavailable and `isIgnored` degrades to today's pattern-only
	 * behavior). Sync callers that never call this simply never prime — that
	 * degrade-to-pattern-only is intended, not a bug.
	 */
	ensureTrackedIndex(): Promise<void>;
}

interface IgnoreSource {
	path: string;
	mtimeMs: number;
	size: number;
}

type ProjectIgnoreMatcherWithFreshness = ProjectIgnoreMatcher & {
	getConsumedIgnoreSources(): readonly IgnoreSource[];
	refreshConsumedIgnoreSource(filePath: string): void;
};

function resolveGitIgnoreRoot(startDir: string): string {
	const fallback = path.resolve(startDir);
	let current = fallback;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fallback;
		current = parent;
	}
}

function collapseSlashes(value: string): string {
	let out = "";
	let previousWasSlash = false;
	for (const ch of value) {
		if (ch === "/") {
			if (!previousWasSlash) out += ch;
			previousWasSlash = true;
			continue;
		}
		out += ch === "\\" ? "/" : ch;
		previousWasSlash = false;
	}
	return out;
}

function stripLeadingDotSlash(value: string): string {
	return value.startsWith("./") ? value.slice(2) : value;
}

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end -= 1;
	return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
	let start = 0;
	while (start < value.length && value[start] === "/") start += 1;
	return value.slice(start);
}

function normalizeIgnorePath(value: string): string {
	return collapseSlashes(stripLeadingDotSlash(value));
}

function stripTrailingSpaces(value: string): string {
	// Good-enough gitignore whitespace handling: unescaped trailing spaces are ignored.
	let end = value.length;
	while (end > 0 && value[end - 1] === " " && value[end - 2] !== "\\") end -= 1;
	return value.slice(0, end).replace(/\\ /g, " ");
}

function parseGitignoreContent(
	content: string,
	layer: GitignorePatternLayer,
): GitignorePattern[] {
	const patterns: GitignorePattern[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		let line = stripTrailingSpaces(rawLine.trimStart());
		if (!line || line.startsWith("#")) continue;
		let negated = false;
		if (line.startsWith("!")) {
			negated = true;
			line = line.slice(1);
		}
		line = normalizeIgnorePath(line);
		if (!line) continue;

		const directoryOnly = line.endsWith("/");
		if (directoryOnly) line = stripTrailingSlashes(line);
		const rooted = line.startsWith("/");
		if (rooted) line = stripLeadingSlashes(line);
		if (!line) continue;

		patterns.push({
			pattern: line,
			negated,
			directoryOnly,
			rooted,
			hasSlash: line.includes("/"),
			layer,
		});
	}
	return patterns;
}

function expandGitignorePattern(pattern: GitignorePattern): string[] {
	const body = pattern.pattern;
	if (pattern.directoryOnly) {
		if (pattern.rooted || pattern.hasSlash) return [body, `${body}/**`];
		return [body, `${body}/**`, `**/${body}`, `**/${body}/**`];
	}
	if (pattern.rooted || pattern.hasSlash) return [body];
	return [body, `**/${body}`];
}

function matchesGitignorePattern(
	pattern: GitignorePattern,
	relativePath: string,
	isDirectory: boolean,
	matchExpanded: (value: string, expanded: string) => boolean,
): boolean {
	const candidate = stripLeadingSlashes(normalizeIgnorePath(relativePath));
	if (!candidate) return false;
	const candidates = isDirectory ? [candidate, `${candidate}/`] : [candidate];
	return expandGitignorePattern(pattern).some((expanded) => {
		if (isDirectory && expanded.endsWith("/**")) {
			const prefix = expanded.slice(0, -3);
			if (candidate === prefix || candidate.startsWith(`${prefix}/`))
				return true;
		}
		return candidates.some((value) => matchExpanded(value, expanded));
	});
}

export function readGitignorePatterns(
	rootDir: string,
	layer: GitignorePatternLayer = "gitignore",
): GitignorePattern[] {
	const gitignorePath = path.join(rootDir, ".gitignore");
	try {
		return parseGitignoreContent(
			fs.readFileSync(gitignorePath, "utf-8"),
			layer,
		);
	} catch {
		return [];
	}
}

function ancestorDirsBetween(rootDir: string, targetDir: string): string[] {
	const relative = path.relative(rootDir, targetDir);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
	const dirs = [rootDir];
	if (!relative) return dirs;
	let current = rootDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		dirs.push(current);
	}
	return dirs;
}

function buildProjectIgnoreMatcher(
	resolvedRoot: string,
	patterns: GitignorePattern[],
): ProjectIgnoreMatcherWithFreshness {
	const consumedIgnoreSources = new Map<string, IgnoreSource>();
	// `signature` lets a caller that already statted the file reuse that one
	// stat (#2016's class on this seam: never re-derive a value you just
	// computed). Callers with no signature in hand still pay their own stat.
	const rememberIgnoreSource = (
		filePath: string,
		signature: FreshnessSignature = fileFreshnessSignature(filePath),
	): void => {
		consumedIgnoreSources.set(filePath, { path: filePath, ...signature });
	};
	rememberIgnoreSource(path.join(resolvedRoot, ".gitignore"));
	const nestedCache = new Map<
		string,
		{
			/**
			 * #2071: the ONE clock this directory's ignore rules and every path
			 * verdict derived from them share. Inside the window neither is
			 * re-checked, so two paths under the same rule cannot disagree.
			 */
			checkedAtMs: number;
			gitignoreMtimeMs: number;
			gitignoreSize: number;
			pilensMtimeMs: number;
			pilensSize: number;
			patterns: GitignorePattern[];
		}
	>();
	// #783: layer a NESTED `.pi-lens.json`'s `ignore` field the same way a
	// nested `.gitignore` is already layered — each ancestor directory between
	// `resolvedRoot` and the target is checked for its OWN config file (no
	// upward walk; `findPiLensConfigInDir`/`loadPiLensConfigInDir` look only
	// directly in `dir`), and its `ignore` patterns are anchored to `dir` (same
	// anchoring semantics as a `.gitignore` living in that directory) and
	// tagged `"pilens"` so #703's tracked-file-rescue rule still skips them.
	// `loadPiLensConfigInDir` reuses `project-lens-config.ts`'s own
	// path+mtime cache, so this never re-reads/re-parses JSON that some other
	// caller (or the root-config lookup above) already loaded.
	const patternsForDir = (dir: string): GitignorePattern[] => {
		if (dir === resolvedRoot) return patterns;
		const cached = nestedCache.get(dir);
		const now = Date.now();
		// #2071: inside the cadence window this directory's rules are frozen, so
		// no stat runs and every verdict already memoized under `dir` stays
		// derivable from exactly these patterns. Before this gate the freshness
		// check ran per call while `patternMemo` did not, which is what let a
		// fresh path and a memoized path in the same directory return opposite
		// verdicts for the same rule. Externally edited nested sources are
		// therefore picked up within PROJECT_IGNORE_FRESHNESS_CADENCE_MS, the
		// same bound #2159 already accepted for the root sources.
		// pi-authored `.gitignore` writes keep their instant path through
		// `invalidateProjectIgnoreMatcherForPath`.
		if (
			cached !== undefined &&
			now - cached.checkedAtMs < PROJECT_IGNORE_FRESHNESS_CADENCE_MS
		) {
			return cached.patterns;
		}
		const gitignoreSig = gitignoreSignature(dir);
		// One stat, two consumers. `rememberIgnoreSource` used to stat the same
		// file a second time on the line below this one.
		rememberIgnoreSource(path.join(dir, ".gitignore"), gitignoreSig);
		// #1105: gate on size too. `findPiLensConfigInDir` returns `size` alongside
		// `mtimeMs` (both from one stat), and `gitignoreSignature` reads both for
		// the nested `.gitignore`, so an mtime-preserving, length-changing edit to
		// EITHER nested source can no longer replay stale patterns for this subtree.
		const pilensInfo = findPiLensConfigInDir(dir);
		const pilensMtime = pilensInfo?.mtimeMs ?? -1;
		const pilensSize = pilensInfo?.size ?? -1;
		if (
			cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
			cached?.gitignoreSize === gitignoreSig.size &&
			cached?.pilensMtimeMs === pilensMtime &&
			cached?.pilensSize === pilensSize
		) {
			// Unchanged: re-arm the shared clock so the next window is measured
			// from this check, not from the build that first populated the entry.
			cached.checkedAtMs = now;
			return cached.patterns;
		}
		const nestedConfig = loadPiLensConfigInDir(dir);
		const nextPatterns = [
			...readGitignorePatterns(dir),
			...parseGitignoreContent(nestedConfig.ignore.join("\n"), "pilens"),
		];
		nestedCache.set(dir, {
			checkedAtMs: now,
			gitignoreMtimeMs: gitignoreSig.mtimeMs,
			gitignoreSize: gitignoreSig.size,
			pilensMtimeMs: pilensMtime,
			pilensSize: pilensSize,
			patterns: nextPatterns,
		});
		// #2071: drift is the SINGLE trigger. The rules under `dir` just changed,
		// so every verdict computed under the superseded rules dies in the same
		// step that supersedes them. `cached === undefined` is a first build, not
		// a change, and has no verdicts to drop.
		if (cached !== undefined) dropVerdictsUnder(dir);
		return nextPatterns;
	};

	// Per-matcher path → pattern-verdict memo. The matcher itself is cached by
	// `getProjectIgnoreMatcher` keyed on `.gitignore` size+mtime (#1105), so this
	// Map's lifetime is bounded to a single set of ignore rules — when any
	// `.gitignore` changes, the matcher is rebuilt and the memo is dropped
	// with it. Without this memo, every background scan (comment scan, knip,
	// jscpd, call-graph, source-filter, pipeline) recomputes O(ancestorDirs ×
	// patterns) per file, multiplying into 2-3s of pure CPU on a 2k-file
	// project. With it, the second visitor of the same path is O(1).
	//
	// #703: this memoizes only the PATTERN verdict (which is deterministic —
	// it never changes for a given matcher instance), NOT the tracked-aware
	// final verdict. The tracked-files set can transition from "not yet
	// primed" to "primed" mid-process (a walker calls `ensureTrackedIndex()`
	// partway through the matcher's lifetime), so baking the tracked check
	// into this memo would let an early, pre-priming call poison every later
	// lookup of the same path for this matcher's entire cache lifetime. The
	// tracked-set lookup itself is a cheap Set#has over syntactically-folded
	// keys (see `isTrackedAndRescued` — no `realpathSync` anywhere in this
	// function), and — critically — it's only ever paid for paths a pattern
	// already flagged as ignored, so it doesn't reintroduce the per-file cost
	// this memo exists to avoid for the common (not-ignored) case.
	const patternMemo = new Map<
		string,
		{ ignored: boolean; layer: GitignorePatternLayer | undefined }
	>();
	/**
	 * Drop every memoized verdict at or below `subtree`, leaving `nestedCache`
	 * alone. `patternsForDir` calls this the moment it rebuilds a directory's
	 * patterns, which is why it must NOT evict the entry that rebuild just
	 * wrote. `invalidateSubtree` layers the eviction on top for the write-hook
	 * path, where the caller knows the source changed but has not re-read it.
	 */
	function dropVerdictsUnder(subtree: string): void {
		const resolvedSubtree = path.resolve(subtree);
		for (const key of patternMemo.keys()) {
			const memoPath = key.slice(2);
			const relative = path.relative(resolvedSubtree, memoPath);
			if (
				!relative ||
				(!relative.startsWith("..") && !path.isAbsolute(relative))
			) {
				patternMemo.delete(key);
			}
		}
	}
	const invalidateSubtree = (subtree: string): void => {
		dropVerdictsUnder(subtree);
		nestedCache.delete(path.resolve(subtree));
	};

	// Compile expanded gitignore globs once per matcher instance. Relative-path
	// resolution remains outside this cache, so nested ignore scopes cannot leak
	// verdicts between sibling trees. The instance lifetime bounds this map.
	const gitignoreGlobOptions: MinimatchOptions = {
		dot: true,
		nocase: process.platform === "win32",
	};
	const compiledGlobs = new Map<string, Minimatch>();
	const matchExpanded = (value: string, expanded: string): boolean => {
		let compiled = compiledGlobs.get(expanded);
		if (compiled === undefined) {
			compiled = new Minimatch(expanded, gitignoreGlobOptions);
			compiledGlobs.set(expanded, compiled);
		}
		return compiled.match(value);
	};

	// #703 perf follow-up: `normalizeEphemeralMapKey` (cheap slash-fold +
	// Windows-lowercase, zero fs I/O), NOT `normalizeMapKey` (realpath-backed).
	// This runs on every `isIgnored` call that reaches this branch — walks
	// over this repo alone visit thousands of pattern-ignored compiled
	// `*.js`/`*.d.ts` files, and `dispatch/integration.ts`'s per-edit cascade
	// check hits it too — so a `realpathSync` here would violate the
	// event-loop/slow-FS discipline `isIgnored` is required to keep (#462: 75x
	// slower on 9p/drvfs). Both `resolved` (this matcher's own `path.resolve`,
	// never realpath'd) and the tracked-set's keys (`git-tracked-ignore.ts`,
	// realpath'd ONCE per fetch on the shared root, not per file) are
	// self-consistent within one process/session, which is exactly
	// `normalizeEphemeralMapKey`'s contract — see that function's doc and
	// `git-tracked-ignore.ts`'s module doc for the full reasoning. Accepted
	// edge case: a symlinked or 8.3-short-name project root can make the cheap
	// fold miss even after the fetch side's one realpath — the file then stays
	// pattern-ignored, i.e. degrades to today's (pre-#703) behavior, which is
	// consistent with this whole feature's fail-open contract.
	function isTrackedAndRescued(resolved: string): boolean {
		const snapshot = getTrackedFilesSnapshot(resolvedRoot);
		if (!snapshot) return false; // never primed / git unavailable: fail-open to pattern-only
		return snapshot.has(normalizeEphemeralMapKey(resolved));
	}

	return {
		rootDir: resolvedRoot,
		patterns,
		getConsumedIgnoreSources: () => [...consumedIgnoreSources.values()],
		refreshConsumedIgnoreSource(filePath: string): void {
			// The freshness sweep refreshes this baseline after invalidation.
			if (consumedIgnoreSources.has(filePath)) rememberIgnoreSource(filePath);
		},
		invalidateSubtree,
		ensureTrackedIndex(): Promise<void> {
			return collectTrackedFiles(resolvedRoot).then(() => undefined);
		},
		isIgnored(filePath: string, isDirectory = false): boolean {
			const resolved = path.resolve(filePath);
			// Two namespaces (D: for directory queries, F: for file queries)
			// because gitignore semantics differ for trailing-slash patterns.
			const memoKey = (isDirectory ? "D:" : "F:") + resolved;
			let verdict = patternMemo.get(memoKey);
			if (verdict === undefined) {
				const rootRelative = path.relative(resolvedRoot, resolved);
				if (
					!rootRelative ||
					rootRelative.startsWith("..") ||
					path.isAbsolute(rootRelative)
				) {
					verdict = { ignored: false, layer: undefined };
				} else {
					let ignored = false;
					let layer: GitignorePatternLayer | undefined;
					const patternDirs = ancestorDirsBetween(
						resolvedRoot,
						path.dirname(resolved),
					);
					for (const dir of patternDirs) {
						const dirPatterns = patternsForDir(dir);
						if (dirPatterns.length === 0) continue;
						const relative = path.relative(dir, resolved);
						const normalized = normalizeIgnorePath(relative);
						for (const pattern of dirPatterns) {
							if (
								!matchesGitignorePattern(
									pattern,
									normalized,
									isDirectory,
									matchExpanded,
								)
							)
								continue;
							ignored = !pattern.negated;
							layer = pattern.layer;
						}
					}
					verdict = { ignored, layer };
				}
				patternMemo.set(memoKey, verdict);
			}

			if (!verdict.ignored) return false;
			// #703 layer semantics: a winning positive match from `global` or
			// `gitignore` emulates git, so it inherits git's "a tracked file is
			// never ignored" rule. A winning match from `pilens` is pi-lens-native
			// intent and stays excluded regardless of tracked status. Directory
			// queries are never tracked-rescued — the tracked set is a file-id
			// set, not a directory set.
			if (
				!isDirectory &&
				verdict.layer !== "pilens" &&
				isTrackedAndRescued(resolved)
			) {
				return false;
			}
			return true;
		},
	};
}

export function createProjectIgnoreMatcher(
	rootDir: string,
	extraPatterns: string[] = [],
	globalPatterns: string[] = [],
): ProjectIgnoreMatcherWithFreshness {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	// Precedence is gitignore order: LATER patterns override earlier ones. So
	// global (lowest) → project .gitignore → project .pi-lens.json (highest),
	// which lets a project `!negation` re-include a globally-ignored path (#252).
	// Each layer is tagged (#703) so `isIgnored` can tell a git-emulating match
	// (`global`/`gitignore` — subject to "a tracked file is never ignored")
	// apart from pi-lens-native intent (`pilens` — excludes regardless).
	const patterns = [
		...parseGitignoreContent(globalPatterns.join("\n"), "global"),
		...readGitignorePatterns(resolvedRoot, "gitignore"),
		...parseGitignoreContent(extraPatterns.join("\n"), "pilens"),
	];
	return buildProjectIgnoreMatcher(resolvedRoot, patterns);
}

const projectIgnoreMatcherCache = new Map<
	string,
	{
		ignoreSources: IgnoreSource[];
		lastIgnoreFreshnessCheckMs: number;
		gitignoreMtimeMs: number;
		/** #1105 second axis for the root `.gitignore` (see FreshnessSignature). */
		gitignoreSize: number;
		lensConfigPath: string | undefined;
		lensConfigMtimeMs: number;
		/** #1105 second axis: an mtime-preserving, length-changing config edit
		 * (git checkout, same-second rewrite) must invalidate the ignore matcher
		 * too, not just `loadPiLensProjectConfig`'s own cache. Size is free from the
		 * stat that already produced `lensConfigMtimeMs`. */
		lensConfigSize: number;
		globalConfigMtimeMs: number;
		/** #1105 second axis for the global `~/.pi-lens/config.json`. */
		globalConfigSize: number;
		matcher: ProjectIgnoreMatcherWithFreshness;
	}
>();

/** Nested ignore sources are checked at most once per root per cadence window. */
export const PROJECT_IGNORE_FRESHNESS_CADENCE_MS = 2_000;

/**
 * `size:mtimeMs` freshness signature for a single file (#1105). mtime alone
 * misses an in-place edit that preserves the timestamp (git checkout, a
 * same-second rewrite) but changes length; size is the free second axis (the
 * same stat already reads it) that catches it. Every ignore-matcher freshness
 * gate below (root + nested `.gitignore` and `.pi-lens.json`) compares BOTH
 * axes so a preserved-mtime, length-changing edit can no longer replay a stale
 * matcher. `{ mtimeMs: -1, size: -1 }` when the file is absent.
 */
interface FreshnessSignature {
	mtimeMs: number;
	size: number;
}

function fileFreshnessSignature(filePath: string): FreshnessSignature {
	try {
		const stat = fs.statSync(filePath);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return { mtimeMs: -1, size: -1 };
	}
}

function globalConfigSignature(): FreshnessSignature {
	return fileFreshnessSignature(getPiLensGlobalConfigPath());
}

function gitignoreSignature(rootDir: string): FreshnessSignature {
	return fileFreshnessSignature(path.join(rootDir, ".gitignore"));
}

function hasIgnoreSourceDrift(sources: readonly IgnoreSource[]): boolean {
	return sources.some((source) => {
		const current = fileFreshnessSignature(source.path);
		return current.mtimeMs !== source.mtimeMs || current.size !== source.size;
	});
}

/**
 * The project config file found by the same upward walk as the loader. Cache
 * invalidation must track the actual file found, not only a file directly under
 * the git root: nested worktrees/submodules can legitimately inherit a
 * `.pi-lens.json` from a parent directory.
 */
function lensConfigInfo(rootDir: string): {
	info: ReturnType<typeof findPiLensProjectConfig>;
	path: string | undefined;
	mtimeMs: number;
	size: number;
} {
	const info = findPiLensProjectConfig(rootDir);
	return info
		? { info, path: info.path, mtimeMs: info.mtimeMs, size: info.size }
		: { info, path: undefined, mtimeMs: -1, size: -1 };
}

export function getProjectIgnoreMatcher(rootDir: string): ProjectIgnoreMatcher {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	const gitignoreSig = gitignoreSignature(resolvedRoot);
	const lensConfig = lensConfigInfo(resolvedRoot);
	const globalSig = globalConfigSignature();
	const cached = projectIgnoreMatcherCache.get(resolvedRoot);
	// A path can be discovered during the previous matcher lookup. Publish only
	// previously unseen sources so a walk cannot replace a pre-edit baseline.
	//
	// This runs BEFORE the sweep below, and the order is load-bearing. A nested
	// source can only be published on a call AFTER the one that consumed it.
	// With the publish second, the sweep never saw a source during the window in
	// which it was discovered, yet still reset `lastIgnoreFreshnessCheckMs`, so
	// the first sweep that could see it ran a FULL cadence later. Pickup was up
	// to 2x cadence, not 1x: measured stale at 2 s and 3 s, fresh at 4 s. The
	// baseline is protected by the `known` set, not by the ordering, so moving
	// the publish earlier cannot let a walk overwrite a pre-edit baseline.
	if (cached) {
		const known = new Set(cached.ignoreSources.map((source) => source.path));
		for (const source of cached.matcher.getConsumedIgnoreSources()) {
			if (!known.has(source.path)) cached.ignoreSources.push(source);
		}
	}
	if (
		cached &&
		Date.now() - cached.lastIgnoreFreshnessCheckMs >=
			PROJECT_IGNORE_FRESHNESS_CADENCE_MS
	) {
		cached.lastIgnoreFreshnessCheckMs = Date.now();
		if (hasIgnoreSourceDrift(cached.ignoreSources)) {
			for (const source of cached.ignoreSources) {
				if (hasIgnoreSourceDrift([source])) {
					const sourceIndex = cached.ignoreSources.findIndex(
						(cachedSource) => cachedSource.path === source.path,
					);
					invalidateProjectIgnoreMatcherForPath(source.path);
					cached.matcher.refreshConsumedIgnoreSource(source.path);
					const refreshedSource = cached.matcher
						.getConsumedIgnoreSources()
						.find((current) => current.path === source.path);
					if (sourceIndex !== -1 && refreshedSource !== undefined) {
						cached.ignoreSources.splice(sourceIndex, 1, refreshedSource);
					}
				}
			}
		}
	}
	if (
		cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
		cached?.gitignoreSize === gitignoreSig.size &&
		cached?.lensConfigPath === lensConfig.path &&
		cached?.lensConfigMtimeMs === lensConfig.mtimeMs &&
		cached?.lensConfigSize === lensConfig.size &&
		cached?.globalConfigMtimeMs === globalSig.mtimeMs &&
		cached?.globalConfigSize === globalSig.size
	) {
		return cached.matcher;
	}

	// Load both configs fresh on cache miss. On a cache HIT (the common case)
	// none of this runs — the only per-call cost is the size:mtimeMs stats above
	// (size is free from the same stat). The project loader is itself
	// size:mtimeMs-cached; the global loader re-parses, but only here on miss
	// (when some tracked signature changed).
	const projectConfig = loadPiLensProjectConfig(resolvedRoot, lensConfig.info);
	const matcher = createProjectIgnoreMatcher(
		resolvedRoot,
		projectConfig.ignore,
		getGlobalIgnorePatterns(),
	);
	projectIgnoreMatcherCache.set(resolvedRoot, {
		ignoreSources: [...matcher.getConsumedIgnoreSources()],
		lastIgnoreFreshnessCheckMs: Date.now(),
		gitignoreMtimeMs: gitignoreSig.mtimeMs,
		gitignoreSize: gitignoreSig.size,
		lensConfigPath: lensConfig.path,
		lensConfigMtimeMs: lensConfig.mtimeMs,
		lensConfigSize: lensConfig.size,
		globalConfigMtimeMs: globalSig.mtimeMs,
		globalConfigSize: globalSig.size,
		matcher,
	});
	return matcher;
}

/**
 * Invalidate the cached matcher state affected by a written `.gitignore`.
 *
 * Root changes discard the whole matcher because they change its base pattern
 * set. Nested changes evict only verdicts in that directory's subtree; the
 * matcher and compiled-glob memo remain reusable for unrelated trees.
 */
export function invalidateProjectIgnoreMatcherForPath(filePath: string): void {
	const resolvedPath = path.resolve(filePath);
	if (path.basename(resolvedPath).toLowerCase() !== ".gitignore") return;
	for (const [cachedRoot, cached] of projectIgnoreMatcherCache) {
		if (!isUnderDir(resolvedPath, cachedRoot)) continue;
		if (
			normalizeFilePath(resolvedPath) ===
			normalizeFilePath(path.join(cachedRoot, ".gitignore"))
		) {
			projectIgnoreMatcherCache.delete(cachedRoot);
			continue;
		}
		cached.matcher.invalidateSubtree(path.dirname(resolvedPath));
	}
}

export function isPathIgnoredByProject(
	filePath: string,
	rootDir: string,
	isDirectory = false,
): boolean {
	return getProjectIgnoreMatcher(rootDir).isIgnored(filePath, isDirectory);
}

/**
 * "Is this a project-source path pi-lens's bookkeeping should care about" —
 * the `isPathIgnoredByProject` + `isExternalOrVendorFile` pair, previously
 * hand-duplicated at each of its 2 call sites (`registerReadBridge` and
 * `registerMutationBridge` in `index.ts`, both #2423). Consolidated here
 * (#2450 review round 2, F4) when a THIRD call site — `tools/lsp-navigation.ts`
 * threading the same gate onto its directly-threaded `LspMutationContext`, so
 * the direct LSP-mutation path and the mutation-bridge fallback path apply
 * the identical gate instead of the fallback silently being narrower. A
 * caller still layers its own `no-read-guard`-style flag check on top; that
 * flag has no file path to check against, so it stays outside this helper.
 */
export function isRecordableProjectPath(
	filePath: string,
	projectRoot: string,
): boolean {
	if (isPathIgnoredByProject(filePath, projectRoot, false)) return false;
	if (isExternalOrVendorFile(filePath, projectRoot)) return false;
	return true;
}

const projectIgnoreGlobsCache = new Map<
	string,
	{ mtimeMs: number; size: number; globs: string[] }
>();

export function getProjectIgnoreGlobs(rootDir: string): string[] {
	const resolvedRoot = path.resolve(rootDir);
	const signature = gitignoreSignature(resolvedRoot);
	const cached = projectIgnoreGlobsCache.get(resolvedRoot);
	if (
		cached &&
		cached.mtimeMs === signature.mtimeMs &&
		cached.size === signature.size
	) {
		return cached.globs;
	}
	const globs = readGitignorePatterns(resolvedRoot)
		.filter((pattern) => !pattern.negated)
		.flatMap((pattern) => expandGitignorePattern(pattern));
	projectIgnoreGlobsCache.set(resolvedRoot, { ...signature, globs });
	return globs;
}

/**
 * Read simple directory-name entries from a root .gitignore.
 *
 * Prefer createProjectIgnoreMatcher() for path-aware gitignore matching. This
 * helper is kept for callers/tests that only need simple directory names.
 */
export function readGitignoreDirs(rootDir: string): string[] {
	return readGitignorePatterns(rootDir)
		.filter(
			(entry) =>
				!entry.negated &&
				!entry.pattern.includes("*") &&
				!entry.pattern.includes("?") &&
				!entry.pattern.includes("[") &&
				!entry.pattern.includes("/"),
		)
		.map((entry) => entry.pattern);
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Match directory name against exclusion patterns.
 * Supports exact names and lightweight glob patterns (for example `*.dSYM`).
 */
export function isExcludedDirName(
	dirName: string,
	extraPatterns: string[] = [],
): boolean {
	const candidate = dirName.trim();
	if (!candidate) return false;

	const patterns = [...EXCLUDED_DIRS, ...extraPatterns]
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const candidateLower = candidate.toLowerCase();

	for (const pattern of patterns) {
		const patLower = pattern.toLowerCase();
		if (!patLower.includes("*") && !patLower.includes("?")) {
			if (candidateLower === patLower) return true;
			continue;
		}
		if (globToRegExp(pattern).test(candidate)) return true;
	}

	return false;
}

/**
 * Convert excluded directory names into glob patterns used by scanners.
 */
export function getExcludedDirGlobs(): string[] {
	return EXCLUDED_DIRS.map((dir) => `**/${dir}/**`);
}

/**
 * Shared Knip ignore patterns derived from central exclusions.
 */
export function getKnipIgnorePatterns(): string[] {
	return [
		...getExcludedDirGlobs(),
		"**/*.test.ts",
		"**/*.test.tsx",
		"**/*.test.js",
		"**/*.test.jsx",
		"**/*.spec.ts",
		"**/*.spec.tsx",
		"**/*.spec.js",
		"**/*.spec.jsx",
		"**/*.poc.test.ts",
		"**/*.poc.test.tsx",
		"**/__tests__/**",
		"**/tests/**",
	];
}

/**
 * Spawn a command and detect whether it modified a file on disk.
 * Returns 1 if the file content changed after the command ran, 0 otherwise.
 * Useful for auto-fix tools (ESLint, Stylelint, RuboCop, etc.).
 */
export async function detectFileChangedAfterCommand(
	filePath: string,
	command: string,
	args: string[],
	cwd: string,
	ignoreStatuses: number[] = [],
): Promise<number> {
	let before = "";
	try {
		before = fs.readFileSync(filePath, "utf-8");
	} catch {
		return 0;
	}

	// #1995: a command cooling down after a spawn timeout must not be handed
	// a second budget - autofix is one of the lanes that paid twice for a
	// wedged .cmd shim. Return "no fix applied" (an honest not-checked).
	if (isInSpawnTimeoutCooldown(command)) return 0;

	const result = await safeSpawnAsync(command, args, {
		timeout: 30000,
		cwd,
	});
	if (result.error) return 0;
	if (result.failure === "timeout") {
		noteSpawnTimeout({
			tool: path.basename(command).replace(/\.[^.]+$/, ""),
			command,
			phase: "autofix",
			durationMs: 30000,
			teardown: result.timeoutTeardown,
		});
		return 0;
	}
	if (result.status !== 0 && !ignoreStatuses.includes(result.status ?? -1)) {
		return 0;
	}

	try {
		const after = fs.readFileSync(filePath, "utf-8");
		return before !== after ? 1 : 0;
	} catch {
		return 0;
	}
}

/**
 * Check if file path is a test/fixture/mock file.
 * Used by secrets scanner, rate command, and dispatch runners
 * to skip these files (false positives on fake credentials, etc).
 */
export function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return (
		normalized.includes(".test.") ||
		normalized.includes(".spec.") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("__tests__/") ||
		normalized.includes("test-utils") ||
		normalized.startsWith("test-") ||
		normalized.includes(".fixture.") ||
		normalized.includes(".mock.")
	);
}
