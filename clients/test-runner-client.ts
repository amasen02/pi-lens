/**
 * Test Runner Client for pi-lens
 *
 * Detects test files and runs them on write/edit to provide
 * immediate test feedback to the AI agent.
 *
 * Supports: vitest, jest, pytest, go, cargo, dotnet, gradle, maven, rspec,
 * minitest, phpunit, mix (extensible to more)
 *
 * Design: File-level targeted testing — only runs tests for the
 * specific file being edited, not the entire suite.
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.js";
import { detectFileRole } from "./file-role.js";
import { findGlobalBinary } from "./package-manager.js";
import { isMeasuredDuration, toMeasuredDurationMs } from "./run-duration.js";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

export interface TestResult {
	file: string; // test file that was run
	sourceFile: string; // the file the agent edited
	runner: string; // "vitest", "jest", "pytest"
	passed: number;
	failed: number;
	skipped: number;
	failures: TestFailure[];
	duration: number; // ms
	error?: string; // if runner itself failed
}

export interface TestFailure {
	name: string; // test name
	message: string; // failure message
	location?: string; // "file.ts:42"
	stack?: string; // abbreviated stack trace
}

// Runner detection: config file → runner name
export interface RunnerConfig {
	configFiles: string[];
	command: string;
	// Name of the binary in node_modules/.bin (and every package manager's
	// global bin dir) — defaults to the runner key. Must match the ACTUAL
	// binary name resolution looks for (e.g. rspec's real binary is "bundle",
	// not "rspec" — see the rspec entry below), because `stripWrapperArgs`
	// only drops args()'s leading element(s) when they match this name (see
	// its doc comment for the exact wrapper-convention rule it applies).
	binName?: string;
	args: (testFile: string, cwd: string) => string[];
	parseJson: boolean;
}

// Source file → test file patterns (reverse lookup)
const SOURCE_TO_TEST_PATTERNS: Array<{
	ext: string;
	testExts: string[];
	dirs: string[];
}> = [
	{
		ext: ".ts",
		testExts: [".test.ts", ".spec.ts"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".tsx",
		testExts: [".test.tsx", ".spec.tsx"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".js",
		testExts: [".test.js", ".spec.js"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".jsx",
		testExts: [".test.jsx", ".spec.jsx"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".py",
		testExts: ["test_*.py", "*_test.py"],
		dirs: ["tests", "test", ".", "."],
	},
	{ ext: ".go", testExts: ["_test.go"], dirs: [".", ".", ".", "."] }, // Go tests are co-located
	{ ext: ".rs", testExts: [".rs"], dirs: ["tests", "tests", "src", "."] }, // Rust: tests/ or #[test] in src
	// PHPUnit convention: tests/ mirrors src/ with ClassNameTest.php naming
	// (e.g. src/Foo/Bar.php -> tests/Foo/BarTest.php). Basename is already the
	// class name (PHP files are named after their class), so no case transform
	// is needed — the mirrored-directory search below handles the tests/ root.
	{ ext: ".php", testExts: ["Test.php"], dirs: ["tests"] },
	// ExUnit convention: test/ mirrors lib/ with a _test.exs suffix on the same
	// basename (e.g. lib/accounts/user.ex -> test/accounts/user_test.exs).
	{ ext: ".ex", testExts: ["_test.exs"], dirs: ["test"] },
];

// Bound for walking up parent directories to find a hoisted node_modules
// (monorepo workspaces) — deep enough for realistic nesting
// (repo/packages/scope/pkg-name), never unbounded to the filesystem root.
const MAX_NODE_MODULES_WALK_UP = 5;

// Bound for recursive descent into a Python test directory when the exact
// same-relative-subdir mirror doesn't match (e.g. tests/unit/ grouping by
// test type rather than mirroring source layout) — capped depth, never an
// unbounded walk of the whole tests tree.
const MAX_PYTEST_RECURSE_DEPTH = 3;

// --- Runner Detection ---

export const RUNNERS: Record<string, RunnerConfig> = {
	vitest: {
		configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
		command: "npx",
		binName: "vitest",
		args: (testFile, _cwd) => [
			"vitest",
			"run",
			testFile,
			"--reporter=json",
			"--passWithNoTests",
		],
		parseJson: true,
	},
	jest: {
		configFiles: [
			"jest.config.ts",
			"jest.config.js",
			"jest.config.json",
			".jestrc.js",
		],
		command: "npx",
		binName: "jest",
		args: (testFile, _cwd) => [
			"jest",
			testFile,
			"--json",
			"--passWithNoTests",
			"--forceExit",
		],
		parseJson: true,
	},
	pytest: {
		configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
		command: "python",
		args: (testFile, _cwd) => ["-m", "pytest", testFile, "--tb=short", "-q"],
		parseJson: false, // pytest JSON requires plugin, use text parsing
	},
	go: {
		configFiles: ["go.mod"],
		command: "go",
		args: (testFile, cwd) => {
			// Convert file path to package path
			const relPath = path.relative(cwd, testFile);
			const pkgDir = path.dirname(relPath);
			return ["test", `-run`, ".", `./${pkgDir === "." ? "." : pkgDir}`];
		},
		parseJson: false, // Go test output is text-based
	},
	cargo: {
		configFiles: ["Cargo.toml"],
		command: "cargo",
		args: (_testFile, _cwd) => ["test", "--no-fail-fast"],
		parseJson: false, // cargo test output is text-based
	},
	dotnet: {
		configFiles: ["*.csproj", "*.sln"],
		command: "dotnet",
		args: (_testFile, _cwd) => ["test", "--no-build"],
		parseJson: false,
	},
	gradle: {
		configFiles: ["build.gradle", "build.gradle.kts", "settings.gradle"],
		command: process.platform === "win32" ? "gradlew.bat" : "./gradlew",
		args: (_testFile, _cwd) => ["test", "--no-daemon"],
		parseJson: false,
	},
	maven: {
		configFiles: ["pom.xml"],
		command: "mvn",
		args: (_testFile, _cwd) => ["test", "-q"],
		parseJson: false,
	},
	rspec: {
		configFiles: [".rspec", "spec/spec_helper.rb"],
		command: "bundle",
		// The real binary is "bundle" (the command runs `bundle exec rspec
		// <file>`), NOT "rspec" — without this, binName defaulted to the
		// runner key "rspec" and local/global resolution looked for the wrong
		// binary name (#1098).
		binName: "bundle",
		args: (testFile, _cwd) => ["exec", "rspec", testFile],
		parseJson: false,
	},
	minitest: {
		configFiles: ["Gemfile"],
		command: "ruby",
		args: (testFile, _cwd) => ["-Itest", testFile],
		parseJson: false,
	},
	phpunit: {
		// phpunit.xml(.dist) is the strong signal; composer.json is checked for
		// a require-dev dependency on phpunit/phpunit (see the special case in
		// detectRunner's Priority-1 loop, mirroring the pytest/pyproject.toml
		// handling above).
		configFiles: ["phpunit.xml", "phpunit.xml.dist", "composer.json"],
		command: "phpunit",
		args: (testFile, _cwd) => [testFile],
		parseJson: false, // PHPUnit's default CLI output is text-based
	},
	mix: {
		configFiles: ["mix.exs"],
		command: "mix",
		args: (testFile, _cwd) => ["test", testFile],
		parseJson: false, // mix test's default output is text-based
	},
};

/**
 * Drop the leading arg(s) of a runner's args() that merely NAME the binary
 * being invoked (the npx-wrapper convention: `npx vitest run …` → once
 * `vitest` becomes the resolved command itself, the leading "vitest" arg is
 * redundant). This must NOT strip a real subcommand.
 *
 * Two wrapper shapes are recognized:
 *   - `[binName, ...rest]` (vitest/jest-style: `npx <bin> ...`) → drop 1.
 *   - `["-m", binName, ...rest]` (pytest-style: `python -m <bin> ...`) → drop 2.
 * Anything else (cargo's `["test", "--no-fail-fast"]`, go's
 * `["test", "-run", …]`, rspec's `["exec", "rspec", file]` once binName is
 * "bundle", etc.) is a real subcommand/argv and is returned unchanged (#1098).
 */
export function stripWrapperArgs(binName: string, args: string[]): string[] {
	if (args[0] === binName) return args.slice(1);
	if (args[0] === "-m" && args[1] === binName) return args.slice(2);
	return args;
}

// --- Client ---

export class TestRunnerClient {
	private log: (msg: string) => void;
	private availableRunners: Map<string, boolean> = new Map();
	private failedTestsByRunner: Map<string, Set<string>> = new Map();
	// Best-effort vitest config `test.include`/`test.exclude` globs, scraped as
	// plain text (never executed) and cached per cwd so the config file is
	// only read/parsed once, not on every edit. `null` means "no config found
	// or it couldn't be parsed in the simple shape we look for" — callers
	// treat that as "no additional signal" and fall back to naming-convention
	// detection only.
	private vitestTestGlobsCache: Map<
		string,
		{ include?: string[]; exclude?: string[] } | null
	> = new Map();

	constructor(verbose = false) {
		this.log = verbose
			? createSubsystemLogger("test-runner")
			: () => {};
	}

	/**
	 * Check if a test runner is available in the project
	 * Detection order:
	 * 1. Config files (vitest.config.ts, jest.config.js, etc.)
	 * 2. package.json dependencies
	 * 3. node_modules presence
	 */
	detectRunner(
		cwd: string,
		sourceFilePath?: string,
	): { runner: string; config: RunnerConfig } | null {
		// Priority 1: Config files
		for (const [name, config] of Object.entries(RUNNERS)) {
			const cacheKey = `${cwd}:${name}:config`;
			if (this.availableRunners.has(cacheKey)) {
				if (this.availableRunners.get(cacheKey)) {
					return { runner: name, config };
				}
				continue;
			}

			const found = config.configFiles.some((cf) => {
				if (name === "pytest" && cf === "pyproject.toml") {
					const pyprojectPath = path.join(cwd, cf);
					if (!fs.existsSync(pyprojectPath)) return false;
					try {
						const pyproject = fs.readFileSync(pyprojectPath, "utf-8");
						return pyproject.includes("[tool.pytest.ini_options]");
					} catch {
						return false;
					}
				}
				if (name === "phpunit" && cf === "composer.json") {
					const composerPath = path.join(cwd, cf);
					if (!fs.existsSync(composerPath)) return false;
					try {
						const composer = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
						const allDeps = {
							...composer.require,
							...composer["require-dev"],
						};
						return Boolean(allDeps["phpunit/phpunit"]);
					} catch {
						return false;
					}
				}
				return fs.existsSync(path.join(cwd, cf));
			});

			this.availableRunners.set(cacheKey, found);
			if (found) {
				this.log(`Detected runner via config: ${name}`);
				return { runner: name, config };
			}
		}

		const packageJsonPath = path.join(cwd, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			const allDeps = {
				...pkg.dependencies,
				...pkg.devDependencies,
			};

			// Check for vitest first (more specific than jest)
			if (allDeps.vitest) {
				this.log("Detected vitest in package.json");
				this.availableRunners.set(`${cwd}:vitest:config`, true);
				return { runner: "vitest", config: RUNNERS.vitest };
			}
			if (allDeps.jest) {
				this.log("Detected jest in package.json");
				this.availableRunners.set(`${cwd}:jest:config`, true);
				return { runner: "jest", config: RUNNERS.jest };
			}
			if (allDeps.pytest || allDeps["pytest-cov"]) {
				this.log("Detected pytest in package.json (unusual)");
				this.availableRunners.set(`${cwd}:pytest:config`, true);
				return { runner: "pytest", config: RUNNERS.pytest };
			}
		} catch (err) {
			void err;
			// package.json parse error or file not found
		}

		// Priority 3: Check node_modules for installed packages, including a
		// hoisted monorepo layout where cwd is a workspace package (e.g.
		// packages/foo) but the runner only lives in node_modules at the
		// workspace root (npm/yarn/pnpm workspace hoisting). Walk up a
		// bounded number of parent directories looking for a node_modules
		// containing the package — never an unbounded walk to the
		// filesystem root.
		const hoistedVitest = this.findHoistedNodeModulesPackage(cwd, "vitest");
		if (hoistedVitest) {
			this.log(`Detected vitest in node_modules (${hoistedVitest})`);
			return { runner: "vitest", config: RUNNERS.vitest };
		}
		const hoistedJest = this.findHoistedNodeModulesPackage(cwd, "jest");
		if (hoistedJest) {
			this.log(`Detected jest in node_modules (${hoistedJest})`);
			return { runner: "jest", config: RUNNERS.jest };
		}

		for (const name of ["go", "cargo", "dotnet", "gradle", "maven"]) {
			const config = RUNNERS[name];
			const found = config.configFiles.some((cf) => {
				// Handle glob patterns like *.csproj
				if (cf.includes("*")) {
					try {
						const files = fs.readdirSync(cwd);
						return files.some((f) =>
							new RegExp(cf.replace(/\*/g, ".*")).test(f),
						);
					} catch {
						return false;
					}
				}
				return fs.existsSync(path.join(cwd, cf));
			});
			if (found) {
				this.log(`Detected ${name} from config file`);
				return { runner: name, config };
			}
		}

		// Priority 5: Check if pytest is available globally (Python files only)
		const isPythonSource =
			typeof sourceFilePath === "string" && sourceFilePath.endsWith(".py");
		if (!isPythonSource) return null;

		try {
			const whichCmd = process.platform === "win32" ? "where" : "which";
			const result = safeSpawn(whichCmd, ["pytest"], {
				timeout: 2000,
			});
			if (result.status === 0) {
				this.log("Detected pytest globally");
				return { runner: "pytest", config: RUNNERS.pytest };
			}
		} catch (err) {
			void err;
		}

		return null;
	}

	/**
	 * Walk up from `cwd` through parent directories looking for a
	 * `node_modules/<packageName>` — handles monorepo workspace hoisting
	 * (npm/yarn/pnpm), where a workspace package's own `node_modules` may
	 * not exist at all, with dependencies hoisted to the workspace root
	 * several directories up. Bounded by `MAX_NODE_MODULES_WALK_UP` levels
	 * and stops at the filesystem root — never an unbounded walk.
	 * Returns the `node_modules` directory where the package was found, or
	 * null if not found within the bound.
	 */
	private findHoistedNodeModulesPackage(
		cwd: string,
		packageName: string,
	): string | null {
		let dir = path.resolve(cwd);
		for (let level = 0; level <= MAX_NODE_MODULES_WALK_UP; level++) {
			const nodeModulesPath = path.join(dir, "node_modules");
			if (fs.existsSync(path.join(nodeModulesPath, packageName))) {
				return nodeModulesPath;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break; // reached filesystem root
			dir = parent;
		}
		return null;
	}

	/**
	 * Depth-bounded breadth-first search under `rootDir` for a pytest-style
	 * test file matching `pattern` (exact, e.g. `test_foo.py`) or the
	 * looser `test_*<basename>*.py` convention. Used as a last-resort
	 * fallback when a Python test suite groups tests by kind
	 * (`tests/unit/`, `tests/integration/`) instead of mirroring the
	 * source directory layout, so the exact-mirror candidates in
	 * `findTestFile` don't match. Bounded by `maxDepth` levels below
	 * `rootDir` and skips hidden directories and `__pycache__` — never an
	 * unbounded walk of the whole tests tree.
	 */
	private findPytestMatchRecursive(
		rootDir: string,
		pattern: string,
		basename: string,
		maxDepth: number,
	): string | null {
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: rootDir, depth: 0 },
		];

		while (queue.length > 0) {
			const next = queue.shift();
			if (!next) break;
			const { dir, depth } = next;

			let entries: import("node:fs").Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isFile()) {
					if (
						entry.name === pattern ||
						(entry.name.startsWith("test_") &&
							entry.name.endsWith(".py") &&
							entry.name.includes(basename))
					) {
						return fullPath;
					}
				} else if (entry.isDirectory() && depth < maxDepth) {
					if (entry.name === "__pycache__" || entry.name.startsWith("."))
						continue;
					queue.push({ dir: fullPath, depth: depth + 1 });
				}
			}
		}

		return null;
	}

	/**
	 * Path of `dir` relative to `cwd`, using forward slashes, or null if `dir`
	 * is not inside `cwd` (e.g. resolves to `..` or an absolute path).
	 * Used to compute a mirrored test-tree subdirectory (e.g. `clients` for
	 * `clients/knip-client.ts`, so `tests/clients/knip-client.test.ts` is
	 * checked alongside the flat `tests/knip-client.test.ts` candidate).
	 */
	private relativeSourceDir(sourceFilePath: string, cwd: string): string | null {
		const dir = path.dirname(sourceFilePath);
		const relDir = path.relative(cwd, path.resolve(cwd, dir));
		if (!relDir || relDir === "." || relDir.startsWith("..") || path.isAbsolute(relDir)) {
			return null;
		}
		return relDir;
	}

	/**
	 * Best-effort, text-only scrape of a vitest config's `test.include` /
	 * `test.exclude` arrays. This deliberately does NOT execute the config
	 * file (that would mean loading arbitrary ESM/TS via Vite's config
	 * loader — too heavy for a per-edit hot path). It just looks for a
	 * simple `include: [ ... ]` / `exclude: [ ... ]` shape with string
	 * literals inside and pulls those out with a regex.
	 *
	 * Returns `null` (never throws) when there's no vitest config file, it
	 * can't be read, or the include/exclude shape isn't a plain array of
	 * string literals (e.g. it's built from a function call, spread, or
	 * template expression) — anything more dynamic than that is out of
	 * scope for this heuristic.
	 *
	 * Cached per `cwd` so the file is only read/parsed once per project,
	 * not on every edit.
	 */
	parseVitestTestGlobs(
		cwd: string,
	): { include?: string[]; exclude?: string[] } | null {
		if (this.vitestTestGlobsCache.has(cwd)) {
			return this.vitestTestGlobsCache.get(cwd) ?? null;
		}

		// .mts isn't in RUNNERS.vitest.configFiles (that list drives runner
		// *detection* priority) but is a legal vitest config extension, so it's
		// included here for the scrape even though detectRunner doesn't check it.
		const candidates = [...RUNNERS.vitest.configFiles, "vitest.config.mts"];

		let content: string | null = null;
		for (const cf of candidates) {
			try {
				content = fs.readFileSync(path.join(cwd, cf), "utf-8");
				break;
			} catch {
				continue;
			}
		}

		let result: { include?: string[]; exclude?: string[] } | null = null;
		if (content !== null) {
			const include = this.extractGlobArrayLiteral(content, "include");
			const exclude = this.extractGlobArrayLiteral(content, "exclude");
			if (include || exclude) {
				result = {};
				if (include) result.include = include;
				if (exclude) result.exclude = exclude;
			}
		}

		this.vitestTestGlobsCache.set(cwd, result);
		return result;
	}

	/**
	 * Extract `<key>: [ 'a', "b", `c` ]` as a plain string array from raw
	 * config text. Returns undefined if the key isn't present, or if the
	 * array body contains anything besides string literals and commas/
	 * whitespace (a function call, spread, variable reference, etc.) —
	 * that's a sign the value is dynamic and this best-effort scrape can't
	 * safely interpret it.
	 */
	private extractGlobArrayLiteral(
		content: string,
		key: string,
	): string[] | undefined {
		const arrayMatch = content.match(
			new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`),
		);
		if (!arrayMatch) return undefined;

		const body = arrayMatch[1];
		const literalPattern = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g;
		const literals: string[] = [];
		let lastEnd = 0;
		let match: RegExpExecArray | null;
		while ((match = literalPattern.exec(body)) !== null) {
			const between = body.slice(lastEnd, match.index).trim();
			// Only whitespace/commas may appear between literals — anything
			// else (identifiers, parens, spreads) means the array isn't a
			// plain list of string literals.
			if (between !== "" && !/^,$/.test(between)) return undefined;
			literals.push(match[1] ?? match[2] ?? match[3] ?? "");
			lastEnd = literalPattern.lastIndex;
		}
		const trailing = body.slice(lastEnd).trim();
		if (trailing !== "" && trailing !== ",") return undefined;

		return literals.length > 0 ? literals : undefined;
	}

	/**
	 * Whether `sourceFilePath` is itself a test file (as opposed to a source
	 * file whose *related* test file needs to be discovered).
	 *
	 * Primary signal: `detectFileRole` (naming convention: `.test.`/`.spec.`
	 * basenames, `test_`/`spec_` prefixes, `__tests__/`/`tests/`/`spec/`
	 * directories — shared with the rest of the codebase, not a second
	 * parallel detector).
	 *
	 * Secondary signal (vitest only): the project's own `test.include` /
	 * `test.exclude` globs, best-effort scraped by `parseVitestTestGlobs`.
	 * This can correct the naming-convention answer in both directions —
	 * an `exclude` glob can rule out a path that looks like a test by name,
	 * and an `include` glob can catch a project that puts tests somewhere
	 * unconventional. When no config is found or it can't be parsed, this
	 * is a no-op and behavior is unchanged.
	 *
	 * #628: a positive `include` override is only trusted when the glob is a
	 * *narrow* test signal (see `isNarrowTestGlob`) — a bare "any file with
	 * this extension" include (e.g. `src/**\/*.ts`) is common in real vitest
	 * configs and matches ordinary source files, so treating any match as
	 * "this is a test" produced vacuous `0p/0f` self-runs on plain source
	 * files (background-review.ts, index.ts, …). The `exclude` direction is
	 * left as a plain match: over-excluding only causes discovery to run on a
	 * file that's actually a test (falls back to `findTestFile`, not a false
	 * "self" positive), which is the safe failure mode.
	 */
	private isTestFile(
		sourceFilePath: string,
		cwd: string,
		runner: string,
	): boolean {
		let result = detectFileRole(sourceFilePath) === "test";

		if (runner === "vitest") {
			const globs = this.parseVitestTestGlobs(cwd);
			if (globs) {
				const rel = path
					.relative(cwd, path.resolve(cwd, sourceFilePath))
					.replace(/\\/g, "/");
				const matches = (
					globs_: string[] | undefined,
					filter?: (g: string) => boolean,
				) =>
					!!globs_?.some(
						(g) => (!filter || filter(g)) && minimatch(rel, g, { dot: true }),
					);

				if (matches(globs.exclude)) {
					result = false;
				} else if (
					!result &&
					matches(globs.include, (g) => this.isNarrowTestGlob(g))
				) {
					result = true;
				}
			}
		}

		return result;
	}

	/**
	 * Whether an `include` glob is a specific enough signal to override a
	 * plain "this is source, not a test" naming-convention verdict (#628).
	 *
	 * Trusted when either:
	 *  - a literal (non-wildcard) path segment before the first wildcard
	 *    names a conventional test location (`tests/`, `test/`, `spec/`,
	 *    `specs/`, `__tests__/`) — the real case this override exists for:
	 *    a project whose test files live in such a directory without a
	 *    `.test.`/`.spec.` name (e.g. `tests/**\/*.ts`).
	 *  - the static suffix after the last wildcard encodes more than the
	 *    bare language extension (e.g. `.check.ts`, `.flow.ts`) — an explicit
	 *    project-specific naming convention, not "any file with this
	 *    extension" (e.g. `**\/*.check.ts`).
	 *
	 * Rejected for a bare extension glob with no test-ish directory (e.g.
	 * `src/**\/*.ts`, `**\/*.ts`) — that shape matches every source file in
	 * the tree and is exactly what produced vacuous self-runs in practice.
	 */
	private isNarrowTestGlob(glob: string): boolean {
		const testDirPattern = /^(tests?|specs?|__tests__)$/i;
		for (const segment of glob.split("/")) {
			if (segment.includes("*") || segment.includes("?")) break;
			if (testDirPattern.test(segment)) return true;
		}

		const lastWildcard = Math.max(glob.lastIndexOf("*"), glob.lastIndexOf("?"));
		const suffix = lastWildcard >= 0 ? glob.slice(lastWildcard + 1) : glob;
		const dotSegments = suffix.split(".").filter(Boolean);
		return dotSegments.length >= 2;
	}

	/**
	 * Find test file for a given source file
	 * Returns the test file path if it exists, null otherwise
	 */
	findTestFile(
		sourceFilePath: string,
		cwd: string,
		runnerOverride?: string,
	): { testFile: string; runner: string } | null {
		const ext = path.extname(sourceFilePath);
		const basename = path.basename(sourceFilePath, ext);
		const dir = path.dirname(sourceFilePath);
		const patterns = SOURCE_TO_TEST_PATTERNS.find((p) => p.ext === ext);
		if (!patterns) return null;

		const detected = runnerOverride
			? { runner: runnerOverride, config: RUNNERS[runnerOverride] }
			: this.detectRunner(cwd, sourceFilePath);
		if (!detected) return null;

		// Relative subdirectory of the source file, used to check a mirrored
		// test-tree layout (tests/<same-subdir>/<basename><testExt>), on top of
		// the flat tests/<basename><testExt> layout already checked below.
		// Null when the source file sits at the project root (dir === ".") or
		// falls outside cwd — in that case there is no subdir to mirror.
		const relDir = this.relativeSourceDir(sourceFilePath, cwd);

		// Check each potential test file location
		for (let i = 0; i < patterns.testExts.length; i++) {
			const testExt = patterns.testExts[i];
			const testDir = patterns.dirs[i];

			// Handle glob patterns (pytest style: test_*.py)
			if (testExt.includes("*")) {
				const pattern = testExt.replace(/\*/g, basename);
				const searchDirs =
					testDir === "."
						? [dir]
						: relDir
							? [path.join(cwd, testDir, relDir), path.join(cwd, testDir)]
							: [path.join(cwd, testDir)];

				for (const searchDir of searchDirs) {
					let files;
					try {
						files = fs.readdirSync(searchDir);
					} catch (err) {
						void err;
						continue;
					}

					const match = files.find(
						(f) =>
							f === pattern ||
							(f.startsWith("test_") &&
								f.endsWith(".py") &&
								f.includes(basename)),
					);
					if (match) {
						const testPath = path.join(searchDir, match);
						this.log(`Found test file: ${testPath}`);
						return { testFile: testPath, runner: detected.runner };
					}
				}

				// None of the exact-mirror candidates matched. Python test
				// suites commonly group tests by kind (tests/unit/,
				// tests/integration/) rather than mirroring the source tree,
				// so do a depth-bounded recursive search under the test
				// root as a last resort before falling back to import
				// scanning — bounded so a large repo can't turn this into
				// an unbounded directory walk.
				if (testDir !== ".") {
					const recursiveMatch = this.findPytestMatchRecursive(
						path.join(cwd, testDir),
						pattern,
						basename,
						MAX_PYTEST_RECURSE_DEPTH,
					);
					if (recursiveMatch) {
						this.log(`Found test file (recursive): ${recursiveMatch}`);
						return { testFile: recursiveMatch, runner: detected.runner };
					}
				}
			} else {
				// Exact pattern match (jest/vitest style)
				const testFilename = basename + testExt;
				const searchPaths = [
					path.join(dir, testFilename), // same directory
					path.join(dir, "__tests__", testFilename), // __tests__ subdirectory
					...(relDir
						? [
								path.join(cwd, "tests", relDir, testFilename), // mirrored tests/<subdir>/
								path.join(cwd, "__tests__", relDir, testFilename), // mirrored __tests__/<subdir>/
							]
						: []),
					path.join(cwd, "tests", testFilename), // top-level tests/
					path.join(cwd, "__tests__", testFilename), // top-level __tests__/
					// PHP/Elixir-style source-root mirroring (e.g. src/Foo/Bar.php ->
					// tests/Foo/BarTest.php, lib/accounts/user.ex ->
					// test/accounts/user_test.exs): strips a conventional source-root
					// segment and mirrors under this pattern's OWN configured test
					// root (testDir), not the hardcoded "tests"/"__tests__" above —
					// ExUnit's root is "test" (singular), which those don't cover.
					...this.sourceRootMirroredCandidates(dir, cwd, testDir, testFilename),
				];

				for (const testPath of searchPaths) {
					if (fs.existsSync(testPath)) {
						this.log(`Found test file: ${testPath}`);
						return { testFile: testPath, runner: detected.runner };
					}
				}
			}
		}

		// Basename lookup found nothing — try import scanning as a fallback.
		const importMatch = this.findTestFileByImport(sourceFilePath, cwd);
		if (importMatch) {
			return { testFile: importMatch, runner: detected.runner };
		}

		return null;
	}

	/**
	 * Select the most useful test target for this edit.
	 *
	 * Strategy:
	 * 1) If there are known failing tests, rerun those first (fast feedback loop).
	 * 2) Otherwise run related tests for the edited file.
	 */
	getTestRunTarget(
		sourceFilePath: string,
		cwd: string,
	): {
		testFile: string;
		runner: string;
		config: RunnerConfig;
		strategy: "failed-first" | "related" | "self";
	} | null {
		const detected = this.detectRunner(cwd, sourceFilePath);
		if (!detected) return null;

		const key = this.failedKey(cwd, detected.runner);
		const failedSet = this.failedTestsByRunner.get(key);

		// If the edited file is itself a test file, there's no "related test"
		// to discover — running findTestFile on it would strip its own
		// extension and search for nonsense like foo.test.test.ts. Skip
		// discovery entirely and treat the file as its own target.
		const selfIsTest = this.isTestFile(sourceFilePath, cwd, detected.runner);
		const related = selfIsTest
			? null
			: this.findTestFile(sourceFilePath, cwd, detected.runner);

		if (failedSet && failedSet.size > 0) {
			if (related) {
				const relatedAbs = path.resolve(related.testFile);
				if (failedSet.has(relatedAbs)) {
					return {
						testFile: relatedAbs,
						runner: detected.runner,
						config: detected.config,
						strategy: "failed-first",
					};
				}
			}

			if (selfIsTest) {
				const selfAbs = path.resolve(sourceFilePath);
				if (failedSet.has(selfAbs)) {
					return {
						testFile: selfAbs,
						runner: detected.runner,
						config: detected.config,
						strategy: "failed-first",
					};
				}
			}

			return {
				testFile: [...failedSet][0],
				runner: detected.runner,
				config: detected.config,
				strategy: "failed-first",
			};
		}

		if (selfIsTest) {
			return {
				testFile: path.resolve(sourceFilePath),
				runner: detected.runner,
				config: detected.config,
				strategy: "self",
			};
		}

		if (!related) return null;

		return {
			testFile: path.resolve(related.testFile),
			runner: detected.runner,
			config: detected.config,
			strategy: "related",
		};
	}

	/**
	 * Run tests for a specific file without blocking the event loop, so LSP
	 * messages, other file writes, and all async operations continue while
	 * tests run.
	 */
	async runTestFileAsync(
		testFile: string,
		cwd: string,
		runner: string,
		config: RunnerConfig,
	): Promise<TestResult> {
		const absoluteTestFile = path.resolve(testFile);
		if (!fs.existsSync(absoluteTestFile)) {
			return this.emptyResult(
				absoluteTestFile,
				"",
				runner,
				"Test file not found",
			);
		}

		try {
			const { command, args } = await this.resolveExec(
				runner,
				config,
				absoluteTestFile,
				cwd,
			);
			this.log(`Running (async): ${command} ${args.join(" ")}`);

			const result = await safeSpawnAsync(command, args, {
				cwd,
				timeout: 60000,
			});

			const stdout = result.stdout || "";
			const stderr = result.stderr || "";

			if (result.error) {
				this.log(`Runner error: ${result.error.message}`);
				return this.emptyResult(
					absoluteTestFile,
					"",
					runner,
					`Runner error: ${result.error.message}`,
				);
			}

			let parsed: TestResult;
			switch (runner) {
				case "vitest":
					parsed = this.parseVitestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "jest":
					parsed = this.parseJestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "pytest":
					parsed = this.parsePytestOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "phpunit":
					parsed = this.parsePhpunitOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
				case "mix":
					parsed = this.parseMixTestOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
				default:
					parsed = this.parseGenericRunnerOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
			}

			this.recordResult(cwd, runner, absoluteTestFile, parsed);
			return parsed;
		} catch (err: any) {
			this.log(`Run error: ${err.message}`);
			return this.emptyResult(absoluteTestFile, "", runner, err.message);
		}
	}

	/**
	 * Check if a source file has corresponding tests (without running them)
	 */
	hasTestFile(sourceFilePath: string, cwd: string): boolean {
		return this.findTestFile(sourceFilePath, cwd) !== null;
	}

	/**
	 * Suggest test files for a list of source files.
	 * Returns deduplicated test file paths with their corresponding source file.
	 */
	suggestTestFiles(
		sourceFiles: string[],
		cwd: string,
	): Array<{ testFile: string; sourceFile: string; runner: string }> {
		const seen = new Set<string>();
		const results: Array<{
			testFile: string;
			sourceFile: string;
			runner: string;
		}> = [];
		for (const sourceFile of sourceFiles) {
			const found = this.findTestFile(sourceFile, cwd);
			if (!found) continue;
			const abs = path.resolve(found.testFile);
			if (seen.has(abs)) continue;
			seen.add(abs);
			results.push({ testFile: abs, sourceFile, runner: found.runner });
		}
		return results;
	}

	// --- Shared JSON test output parser (Vitest + Jest share the same structure) ---

	private parseJsonTestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		interface JsonResult {
			numPassedTests: number;
			numFailedTests: number;
			// #1452: neither reporter emits `numSkippedTests`. Measured against
			// vitest 4.1.10 and jest 30.4.2: a `test.skip` lands in
			// `numPendingTests`, and `test.todo` in `numTodoTests`. Kept in the
			// shape (and still read first) because older reporter versions did
			// emit it and reading a present field costs nothing.
			numSkippedTests?: number;
			numPendingTests?: number;
			numTodoTests?: number;
			testResults?: Array<{
				name: string;
				status: string;
				message?: string;
				// #1452: per-suite wall clock, epoch ms. Present in BOTH reporters
				// (vitest emits `endTime` as a float). NOT `perfStats` — see
				// `jsonRunDurationMs`.
				startTime?: number;
				endTime?: number;
				assertionResults?: Array<{
					status: string;
					title: string;
					duration?: number | null;
					failureMessages?: string[];
					location?: { line: number; column: number };
				}>;
			}>;
		}

		try {
			const json: JsonResult = JSON.parse(stdout);
			const failures: TestFailure[] = [];

			for (const suite of json.testResults || []) {
				if (suite.status === "failed" && suite.assertionResults) {
					for (const test of suite.assertionResults) {
						if (test.status === "failed") {
							failures.push({
								name: test.title,
								message:
									test.failureMessages?.[0] || suite.message || "Test failed",
								location: test.location
									? `${path.relative(cwd, testFile)}:${test.location.line}`
									: undefined,
								stack: this.truncateStack(test.failureMessages?.join("\n")),
							});
						}
					}
				}
			}

			return {
				file: testFile,
				sourceFile: "",
				runner,
				passed: json.numPassedTests || 0,
				failed: json.numFailedTests || 0,
				// #1452: `numSkippedTests` is absent from both reporters' JSON, so
				// this read was always 0. `numPendingTests` is where a `test.skip`
				// actually lands; `numTodoTests` is counted with it because the
				// text parsers (pytest `N skipped`, mix `N excluded` + `N skipped`)
				// also fold every not-run test into one `skipped` figure.
				// `??` would accept a present 0, so a reporter that emits
				// `numSkippedTests: 0` beside a real `numPendingTests` would
				// reproduce the very defect this removes. Take the larger reading.
				skipped: Math.max(
					json.numSkippedTests ?? 0,
					(json.numPendingTests || 0) + (json.numTodoTests || 0),
				),
				failures,
				duration: this.jsonRunDurationMs(json.testResults),
			};
		} catch (err) {
			void err;
			const failed = stdout.includes("FAIL") || stderr.includes("FAIL");
			return this.emptyResult(
				testFile,
				"",
				runner,
				failed ? "Tests failed (could not parse output)" : undefined,
			);
		}
	}

	/**
	 * #1452: real run duration in ms from a vitest/jest `--json` payload.
	 *
	 * NOT `testResults[].perfStats`. That field exists on jest's INTERNAL
	 * `TestResult`, but the JSON reporter's `formatTestResults` projects it to
	 * per-suite `startTime`/`endTime` and drops it — measured absent from both
	 * vitest 4.1.10 and jest 30.4.2 output, so reading it would have left this
	 * at 0. The per-suite epoch pair is what both reporters actually emit.
	 *
	 * Wall-clock SPAN across suites (max end - min start), not a sum: suites in
	 * one payload may have run in parallel workers, and summing would report
	 * more elapsed time than the run took. With the single suite pi-lens
	 * actually produces (one test file per invocation) the two agree.
	 *
	 * The span excludes the runner's own startup: the top-level `startTime` is
	 * ~330ms earlier than the first suite's on this repo. What the per-suite
	 * pair then measures is NOT the same quantity across runners. On vitest it
	 * tracks test time closely (135ms span against 134ms of summed assertions),
	 * but jest stamps a suite's `startTime` before transform and module load,
	 * so the same fields give 5595ms against 128ms of assertions. Both are
	 * honest suite wall clock; neither is comparable to the other, and only the
	 * vitest figure is close to what pytest's `in 0.05s` or ExUnit's
	 * `Finished in 0.05 seconds` report.
	 *
	 * Falls back to the summed per-assertion `duration` when a reporter omits
	 * the suite pair, then to 0. Never returns a negative or non-finite value —
	 * a garbled payload must degrade to "unmeasured" (`formatResult` already
	 * suppresses the suffix on `duration > 0 ? ... : ""`), not to a wrong number.
	 */
	private jsonRunDurationMs(
		suites:
			| Array<{
					startTime?: number;
					endTime?: number;
					assertionResults?: Array<{ duration?: number | null }>;
			  }>
			| undefined,
	): number {
		let minStart = Number.POSITIVE_INFINITY;
		let maxEnd = Number.NEGATIVE_INFINITY;
		let assertionTotal = 0;
		for (const suite of suites || []) {
			if (
				typeof suite.startTime === "number" &&
				Number.isFinite(suite.startTime) &&
				typeof suite.endTime === "number" &&
				Number.isFinite(suite.endTime)
			) {
				minStart = Math.min(minStart, suite.startTime);
				maxEnd = Math.max(maxEnd, suite.endTime);
			}
			for (const assertion of suite.assertionResults || []) {
				if (
					typeof assertion.duration === "number" &&
					Number.isFinite(assertion.duration) &&
					assertion.duration > 0
				) {
					assertionTotal += assertion.duration;
				}
			}
		}
		const span = maxEnd - minStart;
		if (Number.isFinite(span) && span > 0) return Math.round(span);
		return Math.round(Math.max(0, assertionTotal));
	}

	// --- Vitest Parser ---
	private parseVitestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
	}

	// --- Jest Parser ---
	private parseJestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
	}

	// --- Pytest Parser (text-based, no JSON dependency) ---

	private parsePytestOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		_cwd: string,
		runner: string,
	): TestResult {
		const failures: TestFailure[] = [];
		const output = `${stdout}\n${stderr}`;

		// Parse summary line: "5 passed, 2 failed, 1 skipped in 0.23s"
		const summaryMatch =
			output.match(/(\d+)\s+passed?.*?(\d+)\s+failed.*?in\s+([\d.]+)s/i) ||
			output.match(/(\d+)\s+passed.*?in\s+([\d.]+)s/i);

		let passed = 0;
		let failed = 0;
		let skipped = 0;
		let duration = 0;

		if (summaryMatch) {
			// Extract numbers from various patterns
			const passedMatch = output.match(/(\d+)\s+passed/);
			const failedMatch = output.match(/(\d+)\s+failed/);
			const skippedMatch = output.match(/(\d+)\s+skipped/);
			const durationMatch = output.match(/in\s+([\d.]+)s/);

			passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
			failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
			skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
			duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : 0;
		}

		// Parse individual failures: "FAILED tests/test_foo.py::test_something - AssertionError: ..."
		const failureRegex = /FAILED\s+(\S+::\S+)\s*-\s*(.+?)(?:\n|$)/g;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({
				name: match[1],
				message: match[2].trim().slice(0, 500),
				location: match[1].replace("::", ":"),
			});
		}

		// Also look for assertion errors with traceback
		const tracebackRegex = /_{10,}\s*\n\s*(\w+Error:\s*.+?)(?:\n|$)/gs;
		while ((match = tracebackRegex.exec(output)) !== null) {
			// Add to last failure if exists, or create generic
			if (failures.length > 0 && !failures[failures.length - 1].stack) {
				failures[failures.length - 1].stack = match[1].trim().slice(0, 1000);
			}
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error: exitCode === 2 ? "Pytest configuration error" : undefined,
		};
	}

	// --- PHPUnit Parser (text-based, default CLI output) ---

	private parsePhpunitOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		let passed = 0;
		let failed = 0;
		let skipped = 0;

		// Success (or success-with-incomplete/skipped): "OK (12 tests, 34 assertions)"
		const okMatch = output.match(/OK\s*\((\d+)\s+tests?,\s*\d+\s+assertions?\)/i);
		if (okMatch) {
			passed = Number.parseInt(okMatch[1], 10);
		} else {
			// Failure summary: "Tests: 12, Assertions: 34, Errors: 1, Failures: 2, Skipped: 1."
			const testsMatch = output.match(/Tests:\s*(\d+)/i);
			const failuresMatch = output.match(/Failures:\s*(\d+)/i);
			const errorsMatch = output.match(/Errors:\s*(\d+)/i);
			const skippedMatch = output.match(/Skipped:\s*(\d+)/i);

			const total = testsMatch ? Number.parseInt(testsMatch[1], 10) : 0;
			const failures = failuresMatch ? Number.parseInt(failuresMatch[1], 10) : 0;
			const errors = errorsMatch ? Number.parseInt(errorsMatch[1], 10) : 0;
			skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
			failed = failures + errors;
			passed = Math.max(0, total - failed - skipped);
		}

		// Individual failures: "1) Foo\BarTest::testSomething"
		const failures: TestFailure[] = [];
		const failureRegex = /^\d+\)\s+(\S+)/gm;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({ name: match[1], message: match[1] });
		}

		// #1452: PHPUnit prints its own elapsed time and this parser dropped it,
		// so every PHPUnit run reported 0ms. Two shapes are accepted because the
		// summary changed across supported majors:
		//   PHPUnit >= 9.3   "Time: 00:00.123, Memory: 8.00 MB"   (HH:)MM:SS.mmm
		//   PHPUnit <= 9.2   "Time: 1.23 seconds, Memory: 10.00MB" | "Time: 123 ms"
		// NOT VERIFIED AGAINST A LIVE PHPUnit — there is no PHP toolchain on the
		// box this was written on. Both shapes are covered by unit tests against
		// literal summary lines taken from the PHPUnit printers, and the parser
		// leaves duration at 0 when neither matches, so an unrecognised summary
		// degrades to today's behaviour rather than to a wrong figure.
		let duration = 0;
		const clockMatch = output.match(
			/^Time:\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/im,
		);
		if (clockMatch) {
			const hours = clockMatch[1] ? Number.parseInt(clockMatch[1], 10) : 0;
			const minutes = Number.parseInt(clockMatch[2], 10);
			const seconds = Number.parseInt(clockMatch[3], 10);
			// ".1" is a tenth, ".12" hundredths — pad rather than parseInt, or
			// "Time: 00:00.1" would read as 1ms instead of 100ms.
			const millis = clockMatch[4]
				? Number.parseInt(clockMatch[4].padEnd(3, "0"), 10)
				: 0;
			duration = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
		} else {
			const legacyMatch = output.match(
				/^Time:\s*([\d.]+)\s*(seconds?|s|ms|milliseconds?|minutes?)\b/im,
			);
			if (legacyMatch) {
				const value = Number.parseFloat(legacyMatch[1]);
				const unit = legacyMatch[2].toLowerCase();
				const scale = unit.startsWith("ms") || unit.startsWith("milli")
					? 1
					: unit.startsWith("min")
						? 60_000
						: 1000;
				if (Number.isFinite(value) && value > 0) {
					duration = Math.round(value * scale);
				}
			}
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error:
				exitCode !== 0 && passed === 0 && failed === 0
					? "PHPUnit runner error"
					: undefined,
		};
	}

	// --- mix test Parser (ExUnit, text-based, default CLI output) ---

	private parseMixTestOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		let passed = 0;
		let failed = 0;
		let skipped = 0;
		let duration = 0;

		// Summary: "3 tests, 1 failure" (optionally ", N excluded" / ", N skipped")
		const summaryMatch = output.match(
			/(\d+)\s+tests?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+excluded)?(?:,\s*(\d+)\s+skipped)?/i,
		);
		if (summaryMatch) {
			const total = Number.parseInt(summaryMatch[1], 10);
			failed = Number.parseInt(summaryMatch[2], 10);
			const excluded = summaryMatch[3] ? Number.parseInt(summaryMatch[3], 10) : 0;
			const skippedCount = summaryMatch[4]
				? Number.parseInt(summaryMatch[4], 10)
				: 0;
			skipped = excluded + skippedCount;
			passed = Math.max(0, total - failed - skipped);
		}

		const durationMatch = output.match(/Finished in\s+([\d.]+)\s+seconds?/i);
		if (durationMatch) {
			duration = Number.parseFloat(durationMatch[1]) * 1000;
		}

		// Individual failures: "  1) test some behavior (MyModuleTest)"
		const failures: TestFailure[] = [];
		const failureRegex = /^\s*\d+\)\s+(.+?)\s*\(([^)]+)\)\s*$/gm;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({
				name: match[1].trim(),
				message: match[1].trim(),
				location: match[2].trim(),
			});
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error:
				exitCode !== 0 && passed === 0 && failed === 0
					? "mix test runner error"
					: undefined,
		};
	}

	// --- Generic text parser for non-JSON runners ---

	/**
	 * #1480: elapsed time for the runners `parseGenericRunnerOutput` handles.
	 *
	 * Before this, only go's `ok  pkg  0.25s` was read and every other runner
	 * reported a hardcoded 0 — a constant that the turn-end log then printed as
	 * a measurement. Each runner below prints its elapsed time in the same
	 * summary block this parser already regexes for pass/fail counts.
	 *
	 * One parser serves all runners, so every pattern is anchored to the line
	 * that carries the counts (`^test result:`, the `Failed:/Passed:` summary,
	 * `^Finished in`). That matters for the same reason #1452's PHPUnit `Time:`
	 * pattern is anchored: an unanchored /m alternation takes the FIRST match
	 * over stdout+stderr, and a failure diff quoting "Finished in ..." would
	 * beat the real summary. Probes run in a fixed order and the first measured
	 * value wins, so one runner's output cannot be scored by another's pattern.
	 *
	 * Formats and how each was verified:
	 *
	 * - go — `ok  example.com/pkg  0.253s`. Pre-existing pattern, unchanged
	 *   apart from the shared finite/positive guard.
	 *
	 * - cargo — `test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured;
	 *   0 filtered out; finished in 0.253s`. NOT VERIFIED AGAINST A LIVE CARGO
	 *   RUN — this box has no MSVC linker, so `cargo test` cannot link. Format
	 *   read out of the libtest printer shipped with the local rustc 1.94.1:
	 *   `library/test/src/formatters/pretty.rs` builds `"; finished in
	 *   {exec_time}"` and `library/test/src/time.rs` renders `TestSuiteExecTime`
	 *   as `{:.2}s`. Older rustc omits the suffix entirely; that degrades to
	 *   unmeasured.
	 *
	 * - dotnet/vstest — `Failed: 1, Passed: 2, Skipped: 0, Total: 3, Duration:
	 *   1 m 30 s - t.dll (net8.0)`. NOT VERIFIED AGAINST A LIVE `dotnet test` —
	 *   NuGet restore has no network here. Format read out of the
	 *   vstest.console.dll shipped with the local .NET SDK 8.0.423, which holds
	 *   the literal `{0} - Failed: {1}, Passed: {2}, Skipped: {3}, Total: {4},
	 *   Duration: {5}` next to the unit literals `" h"`, `" m"`, `" s"`,
	 *   `" ms"`, `"< 1 ms"`. The duration is a space-joined token list, so it
	 *   is summed rather than read as one number. `< 1 ms` carries no number
	 *   and stays unmeasured.
	 *
	 * - maven/surefire — `Tests run: 4, Failures: 0, Errors: 0, Skipped: 0,
	 *   Time elapsed: 0.05 s -- in com.example.AppTest`. NOT VERIFIED AGAINST A
	 *   LIVE MAVEN — no mvn on this box. Summed across the per-class lines,
	 *   because surefire prints `Time elapsed` per test class and its final
	 *   `Results:` total carries no time. `[INFO] Total time: 3.4 s` is
	 *   deliberately NOT used: that is whole-build wall clock including compile,
	 *   which would report a wrong number rather than none. Surefire 2.x wrote
	 *   `sec` where 3.x writes `s`; both are accepted.
	 *
	 * - rspec — `Finished in 0.32394 seconds (files took 0.49427 seconds to
	 *   load)`. VERIFIED against a live rspec-core 3.13.6 run on ruby 3.4.10.
	 *   The minutes form (`Finished in 2 minutes 15.14 seconds`) comes from
	 *   `RSpec::Core::Formatters::Helpers.format_duration` in the same
	 *   installed gem; rspec never prints hours. Load time trails the run time
	 *   on the same line and must not be read instead of it.
	 *
	 * - minitest — `Finished in 0.254594s, 7.8557 runs/s, 7.8557 assertions/s.`
	 *   VERIFIED against a live minitest 5.25.4 run on ruby 3.4.10. The format
	 *   string is `"Finished in %.6fs, ..."` in minitest.rb, always seconds.
	 *
	 * - gradle — deliberately left unmeasured. Gradle's console summary
	 *   (`4 tests completed, 1 failed`) carries no elapsed time, and `BUILD
	 *   SUCCESSFUL in 3s` is whole-build wall clock including compile and
	 *   dependency resolution. Reporting that as test time would be a wrong
	 *   number; #1479 makes the absence legible in the log instead.
	 */
	private parseGenericRunnerDuration(output: string): number {
		// go: "ok  	example.com/pkg	0.253s"
		const goSummary = output.match(/ok\s+\S+\s+([\d.]+)s/m);
		if (goSummary) {
			const ms = toMeasuredDurationMs(Number.parseFloat(goSummary[1]) * 1000);
			if (ms > 0) return ms;
		}

		// cargo: "...; 0 filtered out; finished in 0.25s"
		const cargoTime = output.match(
			/^test result:.*?;\s*finished in\s+([\d.]+)\s*s\b/im,
		);
		if (cargoTime) {
			const ms = toMeasuredDurationMs(Number.parseFloat(cargoTime[1]) * 1000);
			if (ms > 0) return ms;
		}

		// dotnet/vstest: "..., Total: 3, Duration: 1 m 30 s - t.dll (net8.0)".
		// Anchored to the counts line, and the tail stops at the " - <dll>"
		// separator so an assembly name can never be scanned for units.
		const dotnetTime = output.match(
			/Failed:\s*\d+,\s*Passed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*\d+,\s*Duration:\s*([^\r\n-]+)/i,
		);
		// `< 1 ms` is vstest's "too fast to name a number". Summing the tokens
		// would report 1ms, a number it never claimed.
		if (dotnetTime && !/^\s*</.test(dotnetTime[1])) {
			let total = 0;
			// "ms" before "m", or "250 ms" scores as 250 minutes.
			const units: Record<string, number> = {
				ms: 1,
				s: 1000,
				m: 60_000,
				h: 3_600_000,
			};
			for (const token of dotnetTime[1].matchAll(
				/([\d.]+)\s*(ms|h|m|s)\b/gi,
			)) {
				total += Number.parseFloat(token[1]) * units[token[2].toLowerCase()];
			}
			const ms = toMeasuredDurationMs(total);
			if (ms > 0) return ms;
		}

		// maven/surefire: summed across per-class "Time elapsed" lines.
		let surefireTotal = 0;
		for (const line of output.matchAll(
			/^.*Tests run:\s*\d+,.*?Time elapsed:\s*([\d.]+)\s*(?:s|sec|secs|seconds)\b.*$/gim,
		)) {
			const seconds = Number.parseFloat(line[1]);
			if (Number.isFinite(seconds) && seconds > 0) surefireTotal += seconds;
		}
		if (surefireTotal > 0) {
			const ms = toMeasuredDurationMs(surefireTotal * 1000);
			if (ms > 0) return ms;
		}

		// rspec: "Finished in 2 minutes 15.14 seconds (files took 0.5 ...)"
		const rspecTime = output.match(
			/^Finished in\s+(?:([\d.]+)\s+minutes?\s+)?([\d.]+)\s+seconds?/im,
		);
		if (rspecTime) {
			const minutes = rspecTime[1] ? Number.parseFloat(rspecTime[1]) : 0;
			const ms = toMeasuredDurationMs(
				minutes * 60_000 + Number.parseFloat(rspecTime[2]) * 1000,
			);
			if (ms > 0) return ms;
		}

		// minitest: "Finished in 0.254594s, 7.8557 runs/s, ..."
		const minitestTime = output.match(/^Finished in\s+([\d.]+)s\s*,/im);
		if (minitestTime) {
			const ms = toMeasuredDurationMs(
				Number.parseFloat(minitestTime[1]) * 1000,
			);
			if (ms > 0) return ms;
		}

		// gradle and anything unrecognised: unmeasured, not zero-as-measurement.
		return 0;
	}

	private parseGenericRunnerOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		const lower = output.toLowerCase();

		let passed = 0;
		let failed = exitCode === 0 ? 0 : 1;
		let skipped = 0;
		const duration = this.parseGenericRunnerDuration(output);

		const cargoSummary = output.match(
			/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;/i,
		);
		if (cargoSummary) {
			passed = Number.parseInt(cargoSummary[1], 10);
			failed = Number.parseInt(cargoSummary[2], 10);
			skipped = Number.parseInt(cargoSummary[3], 10);
		}

		const dotnetSummary = output.match(
			/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/i,
		);
		if (dotnetSummary) {
			failed = Number.parseInt(dotnetSummary[1], 10);
			passed = Number.parseInt(dotnetSummary[2], 10);
			skipped = Number.parseInt(dotnetSummary[3], 10);
		}

		// #1480 (adjacent): surefire prints one `Tests run:` line PER TEST CLASS
		// and then the aggregate under `Results:`. Taking the first match scored
		// a multi-class run by its first class alone — a two-class run with a
		// failure in the second class reported 0 failures. The aggregate is
		// last, and for a single-class run first and last are the same line.
		const mavenMatches = [
			...output.matchAll(
				/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/gi,
			),
		];
		const mavenSummary = mavenMatches[mavenMatches.length - 1];
		if (mavenSummary) {
			const total = Number.parseInt(mavenSummary[1], 10);
			const failures = Number.parseInt(mavenSummary[2], 10);
			const errors = Number.parseInt(mavenSummary[3], 10);
			skipped = Number.parseInt(mavenSummary[4], 10);
			failed = failures + errors;
			passed = Math.max(0, total - failed - skipped);
		}

		const rspecSummary = output.match(
			/(\d+)\s+examples?,\s+(\d+)\s+failures?/i,
		);
		if (rspecSummary) {
			const total = Number.parseInt(rspecSummary[1], 10);
			failed = Number.parseInt(rspecSummary[2], 10);
			passed = Math.max(0, total - failed);
		}

		const minitestSummary = output.match(
			/(\d+)\s+runs?,\s+\d+\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?/i,
		);
		if (minitestSummary) {
			const total = Number.parseInt(minitestSummary[1], 10);
			const failures = Number.parseInt(minitestSummary[2], 10);
			const errors = Number.parseInt(minitestSummary[3], 10);
			failed = failures + errors;
			passed = Math.max(0, total - failed);
		}

		const gradleSummary = output.match(
			/(\d+)\s+tests? completed,\s+(\d+)\s+failed/i,
		);
		if (gradleSummary) {
			const total = Number.parseInt(gradleSummary[1], 10);
			failed = Number.parseInt(gradleSummary[2], 10);
			passed = Math.max(0, total - failed);
		}

		if (passed === 0 && failed === 0 && skipped === 0 && exitCode === 0) {
			passed = 1;
		}

		const failures: TestFailure[] = [];
		const names = [
			...output.matchAll(/--- FAIL:\s+([^\s(]+)/g),
			...output.matchAll(/\bFAILED\s+([^\n]+)/g),
			...output.matchAll(/Failure:\s+([^\n]+)/g),
		];
		for (const m of names.slice(0, 5)) {
			failures.push({ name: m[1].trim(), message: m[1].trim() });
		}
		if (failures.length === 0 && failed > 0) {
			const firstLine =
				output
					.split("\n")
					.find((l) => /fail|error|exception/i.test(l))
					?.trim()
					.slice(0, 300) || `Tests failed for runner ${runner}`;
			failures.push({ name: `${runner} failure`, message: firstLine });
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error:
				exitCode !== 0 && failed === 0 && lower.includes("error")
					? `Runner ${runner} exited with ${exitCode}`
					: undefined,
		};
	}

	// --- Formatting ---

	/**
	 * Format test result for LLM consumption
	 */
	formatResult(result: TestResult): string {
		if (result.error && result.passed === 0 && result.failed === 0) {
			// Runner error, not test failure
			return `[Tests] ⚠ Could not run tests: ${result.error}`;
		}

		const total = result.passed + result.failed + result.skipped;
		if (total === 0) {
			return ""; // No tests to report
		}

		// #1479: same "was this measured at all" question the turn-end log asks,
		// answered from the same predicate so the two surfaces cannot drift.
		const durationStr = isMeasuredDuration(result.duration)
			? ` (${(result.duration / 1000).toFixed(2)}s)`
			: "";

		if (result.failed === 0) {
			return `[Tests] ✓ ${result.passed}/${total} passed${durationStr} — ${result.runner}`;
		}

		// Has failures
		let output = `[Tests] ✗ ${result.failed}/${total} failed, ${result.passed} passed${durationStr} — ${result.runner}\n`;

		for (const failure of result.failures.slice(0, 5)) {
			output += `  ✗ ${failure.name}\n`;
			const msg = failure.message.split("\n")[0].slice(0, 200); // First line, truncated
			output += `    ${msg}\n`;
			if (failure.location) {
				output += `    at ${failure.location}\n`;
			}
		}

		if (result.failures.length > 5) {
			output += `  ... and ${result.failures.length - 5} more failure(s)\n`;
		}

		output += `  → Fix failing tests before proceeding\n`;

		return output.trimEnd();
	}

	// --- Helpers ---

	/**
	 * Additional mirrored-directory candidate for source trees whose test
	 * tree mirrors the source tree under a *different*, conventional
	 * source-root segment rather than the source file's full relative
	 * directory — e.g. PHPUnit's `src/Foo/Bar.php` -> `tests/Foo/BarTest.php`
	 * (strips `src`) or ExUnit's `lib/accounts/user.ex` ->
	 * `test/accounts/user_test.exs` (strips `lib`).
	 *
	 * Unlike the `relDir`-based candidates above (which mirror under the
	 * hardcoded "tests"/"__tests__" roots), this uses `testDir` — the
	 * pattern's own configured test root from `SOURCE_TO_TEST_PATTERNS`
	 * (e.g. "tests" for PHP, "test" for Elixir) — since ExUnit's root is
	 * singular and wouldn't otherwise be checked.
	 *
	 * Returns an empty array when the source directory doesn't start with a
	 * known source-root segment (src/lib/app) followed by at least one more
	 * path segment — i.e. this is a no-op for languages/layouts that don't
	 * use this convention.
	 */
	private sourceRootMirroredCandidates(
		dir: string,
		cwd: string,
		testDir: string,
		testFilename: string,
	): string[] {
		const knownSourceRoots = new Set(["src", "lib", "app"]);
		const relDir = path.relative(cwd, dir);
		const segments = relDir.split(path.sep).filter(Boolean);
		if (segments.length > 1 && knownSourceRoots.has(segments[0])) {
			return [
				path.join(cwd, testDir, ...segments.slice(1), testFilename),
			];
		}
		return [];
	}

	/**
	 * Fallback discovery: scan known test directories for a file that imports
	 * the source module. Catches cases where the test file name doesn't match
	 * the source basename (e.g. cline.test.ts testing cline-auth.ts).
	 *
	 * Checks for the basename appearing in a quoted import/require path:
	 *   from "../providers/cline/cline-auth"   → /cline-auth"  ✓
	 *   from "./cline-auth.js"                 → /cline-auth.  ✓
	 *   import("cline-auth")                   → "cline-auth"  ✓
	 */
	private findTestFileByImport(
		sourceFilePath: string,
		cwd: string,
	): string | null {
		const ext = path.extname(sourceFilePath);
		const basename = path.basename(sourceFilePath, ext);
		const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

		const searchDirs = [
			path.join(cwd, "tests"),
			path.join(cwd, "__tests__"),
			path.dirname(sourceFilePath),
		];

		for (const dir of searchDirs) {
			let entries: string[];
			try {
				entries = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!testPattern.test(entry)) continue;
				const testPath = path.join(dir, entry);
				let content: string;
				try {
					content = fs.readFileSync(testPath, "utf-8");
				} catch {
					continue;
				}
				if (
					content.includes(`/${basename}"`) ||
					content.includes(`/${basename}'`) ||
					content.includes(`/${basename}.`) ||
					content.includes(`"${basename}"`) ||
					content.includes(`'${basename}'`)
				) {
					this.log(`Found test file via import scan: ${testPath}`);
					return testPath;
				}
			}
		}
		return null;
	}

	/**
	 * Resolve the executable and args for a runner, preferring a local
	 * node_modules/.bin binary over npx to avoid the ~150ms npx startup cost.
	 *
	 * When a resolved binary becomes the command itself, `stripWrapperArgs`
	 * drops ONLY the leading arg(s) that named the wrapped binary — never a
	 * real subcommand (#1098: `cargo test --no-fail-fast` unconditionally lost
	 * `test` here because the old code assumed every runner's args() started
	 * with an npx-style runner-name arg, which only holds for wrapper-style
	 * runners like vitest/jest/pytest).
	 */
	private async resolveExec(
		runner: string,
		config: RunnerConfig,
		testFile: string,
		cwd: string,
	): Promise<{ command: string; args: string[] }> {
		// PHPUnit has no npx-style automatic local-binary resolution — Composer's
		// standard local-install location is vendor/bin/phpunit, so check that
		// explicitly before falling back to a global `phpunit` on PATH.
		if (runner === "phpunit") {
			const suffix = process.platform === "win32" ? ".bat" : "";
			const vendorBin = path.join(cwd, "vendor", "bin", `phpunit${suffix}`);
			if (fs.existsSync(vendorBin)) {
				return { command: vendorBin, args: config.args(testFile, cwd) };
			}
			return { command: "phpunit", args: config.args(testFile, cwd) };
		}

		const binName = config.binName ?? runner;
		const suffix = process.platform === "win32" ? ".cmd" : "";
		const localBin = path.join(cwd, "node_modules", ".bin", binName + suffix);

		// A resolved binary (local, or any manager's global bin) becomes the command
		// itself, so the leading wrapper-name arg(s) that named it (e.g. "vitest",
		// or "-m pytest") are stripped from args() — see stripWrapperArgs.
		if (fs.existsSync(localBin)) {
			return { command: localBin, args: stripWrapperArgs(binName, config.args(testFile, cwd)) };
		}

		// Any package manager's global bin dir (npm/pnpm/yarn/bun) before npx (#375).
		const globalBin = await findGlobalBinary(binName);
		if (globalBin) {
			return { command: globalBin, args: stripWrapperArgs(binName, config.args(testFile, cwd)) };
		}

		return { command: config.command, args: config.args(testFile, cwd) };
	}

	private emptyResult(
		testFile: string,
		sourceFile: string,
		runner: string,
		error?: string,
	): TestResult {
		return {
			file: testFile,
			sourceFile,
			runner,
			passed: 0,
			failed: 0,
			skipped: 0,
			failures: [],
			duration: 0,
			error,
		};
	}

	private truncateStack(stack?: string): string | undefined {
		if (!stack) return undefined;
		// Keep first 3 lines of stack trace
		const lines = stack.split("\n").slice(0, 3);
		return lines.join("\n").slice(0, 500);
	}

	private failedKey(cwd: string, runner: string): string {
		return `${path.resolve(cwd)}:${runner}`;
	}

	private recordResult(
		cwd: string,
		runner: string,
		testFile: string,
		result: TestResult,
	): void {
		const key = this.failedKey(cwd, runner);
		const abs = path.resolve(testFile);
		const set = this.failedTestsByRunner.get(key) ?? new Set<string>();

		if (result.failed > 0) {
			set.add(abs);
			this.failedTestsByRunner.set(key, set);
			return;
		}

		if (set.has(abs)) {
			set.delete(abs);
			if (set.size === 0) this.failedTestsByRunner.delete(key);
			else this.failedTestsByRunner.set(key, set);
		}
	}
}
