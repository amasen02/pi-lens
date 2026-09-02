/**
 * #2468: `clients/formatters.ts` invoked bare `ktfmt <file>` with no style
 * flag, so ktfmt formatted under its own default style instead of the
 * project's actual Gradle `ktfmt { googleStyle() | kotlinLangStyle() }`
 * selection — the same manifest-detected-but-not-carried defect shape #2466
 * fixed for rustfmt `--edition`.
 *
 * The two argv cases (the carried `--google-style`, and the fallback that
 * must carry nothing) call `ktfmtFormatter.resolveCommand` (the same pattern
 * as `formatters-rustfmt-edition.test.ts`) with a project-local PATH shim so
 * the real `which`/`where` spawn resolves `ktfmt` for real — that pair is the
 * load-bearing regression proof that the style flag reaches, and stays out
 * of, ktfmt's actual argv. The remaining cases call `resolveKtfmtGradleStyle`
 * (`clients/gradle-ktfmt-style.ts`) directly, the same way
 * `formatters-rustfmt-edition.test.ts`'s F5 case calls
 * `resolveCargoPackageEdition` directly for the `homeDir`-override case that
 * `resolveCommand` doesn't expose.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ktfmtFormatter } from "../../clients/formatters.js";
import { resolveKtfmtGradleStyle } from "../../clients/gradle-ktfmt-style.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const tmpDirs: string[] = [];
const isWin = process.platform === "win32";

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) removeTempDirSync(dir);
	}
});

function newTmpDir(prefix: string): string {
	const env = setupTestEnvironment(prefix);
	tmpDirs.push(env.tmpDir);
	return env.tmpDir;
}

function makeFakeKtfmtExe(shimDir: string): void {
	const exeName = isWin ? "ktfmt.cmd" : "ktfmt";
	const filePath = path.join(shimDir, exeName);
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(
		filePath,
		isWin ? "@echo off\r\n" : "#!/bin/sh\necho fake\n",
	);
	if (!isWin) fs.chmodSync(filePath, 0o755);
}

async function withKtfmtOnPath(
	shimDir: string,
	fn: () => Promise<void>,
): Promise<void> {
	makeFakeKtfmtExe(shimDir);
	const origPath = process.env.PATH;
	process.env.PATH = `${shimDir}${path.delimiter}${origPath}`;
	try {
		await fn();
	} finally {
		process.env.PATH = origPath;
	}
}

describe("ktfmtFormatter — Gradle ktfmt{} style carriage (#2468)", () => {
	it("passes --google-style from the nearest ktfmt {} block's googleStyle()", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-google-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n\n' +
				"ktfmt {\n  googleStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "main", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			// The load-bearing assertion: removing the style-flag carriage from
			// the fix collapses this back to [shimPath, filePath] and this line
			// goes red.
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [binary, ...rest] = resolved as string[];
			expect(binary.toLowerCase()).toContain("ktfmt");
			expect(rest).toEqual(["--google-style", filePath]);
		});
	});

	it("resolves --kotlinlang-style for a kotlinLangStyle() declaration", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-kotlinlang-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  kotlinLangStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBe("--kotlinlang-style");
	});

	it("nested module's own ktfmt {} declaration overrides the root's (nearest wins)", async () => {
		const root = newTmpDir("pi-lens-ktfmt-nearest-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			"ktfmt {\n  kotlinLangStyle()\n}\n",
		);
		const filePath = path.join(moduleDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBe("--kotlinlang-style");
	});

	it("falls back (undefined) when no build.gradle(.kts) is found", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-nogradle-");
		const filePath = path.join(tmpDir, "loose.kt");
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBeUndefined();
	});

	it("falls back when the ktfmt {} block declares no recognized style", async () => {
		const tmpDir = newTmpDir("pi-lens-ktfmt-nostyle-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n\n' +
				"ktfmt {\n  maxWidth.set(120)\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBeUndefined();
	});

	it("falls back to the bare argv when the block declares the removed dropboxStyle()", async () => {
		// dropboxStyle() was removed from ktfmt-gradle in 0.19.0 (2024-07-03,
		// "no longer supported by ktfmt") and ktfmt's own CLI never exposed a
		// --dropbox-style flag (verified against ParsedArgs.kt, v0.63). A
		// project still calling it (stale plugin / manual block) must not get
		// a guessed/nonexistent flag passed through.
		//
		// Review round 2, F2: this case used to be routed through a
		// "dropbox-unsupported" sentinel return whose only effect was a debug
		// log — deleting the sentinel branch left every assertion green
		// because the ordinary no-recognized-style fall-through produced the
		// identical argv. The sentinel is gone; the case stays, asserting the
		// thing that is actually load-bearing for a user: the argv ktfmt is
		// spawned with carries no style flag.
		const tmpDir = newTmpDir("pi-lens-ktfmt-dropbox-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  dropboxStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		await withKtfmtOnPath(path.join(tmpDir, "shims"), async () => {
			const resolved = await ktfmtFormatter.resolveCommand?.(filePath, tmpDir);
			expect(resolved).not.toBeNull();
			expect(resolved).not.toBeUndefined();
			const [binary, ...rest] = resolved as string[];
			expect(binary.toLowerCase()).toContain("ktfmt");
			expect(rest).toEqual([filePath]);
		});
	});

	it("stops the ancestor climb at the injected HOME ceiling even when a style sits one level above it", async () => {
		// Mutation-proof HOME-ceiling fixture (mirrors formatters-rustfmt-
		// edition.test.ts's F5 case): the fixture tree puts a build.gradle.kts
		// declaring a style ABOVE an injected `homeDir`, with the formatted
		// file BELOW it and no gradle file of its own between them. If the
		// `homeDir` ceiling inside `findNearestMarkerRoot`'s climb were
		// neutered, the climb would sail past the injected home, find the
		// root's googleStyle(), and this assertion would go red.
		const tmpDir = newTmpDir("pi-lens-ktfmt-homeceiling-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const homeDir = path.join(tmpDir, "home");
		const projectDir = path.join(homeDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const filePath = path.join(projectDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath, homeDir);

		expect(resolved).toBeUndefined();
	});
});

/**
 * Review round 2, F1: the round-1 resolver stopped the ancestor climb at the
 * FIRST directory holding any gradle file (even one declaring no style) and
 * matched `ktfmt {` anywhere in the file with no project scoping. Both halves
 * are wrong in the layout `com.ncorti.ktfmt.gradle` actually gets used in for
 * multi-module builds — the style lives in the ROOT build file's
 * `subprojects { }` / `allprojects { }` body, and the module's own
 * `build.gradle.kts` declares only its plugins.
 *
 * `homeDir` is pinned to the fixture root's parent in every case here so the
 * multi-hop climb is hermetic (it can never reach a real gradle file above
 * `os.tmpdir()`) and so the ceiling is proven to bound the NEW, multi-hop
 * walk, not just the round-1 single-hop one.
 */
describe("resolveKtfmtGradleStyle — Gradle project scoping (#2468 review round 2)", () => {
	function makeSubprojectsFixture(prefix: string, styleCall: string): string {
		const root = newTmpDir(prefix);
		fs.writeFileSync(
			path.join(root, "settings.gradle.kts"),
			'rootProject.name = "demo"\ninclude(":app")\n',
		);
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0" apply false\n}\n\n' +
				"subprojects {\n" +
				'  apply(plugin = "com.ncorti.ktfmt.gradle")\n' +
				`  ktfmt {\n    ${styleCall}\n  }\n` +
				"}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  kotlin("jvm")\n}\n',
		);
		return root;
	}

	function writeKt(dir: string, ...segments: string[]): string {
		const filePath = path.join(dir, ...segments);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");
		return filePath;
	}

	it("B1: carries a root subprojects { ktfmt { googleStyle() } } into a module whose own build file declares no style", async () => {
		// The module's build.gradle.kts exists but declares no ktfmt block, so
		// the round-1 resolver stopped there and returned undefined — while
		// `hasKtfmtConfig` climbed to the root, matched `ktfmt`, and elected
		// ktfmt for this very file. #2468's defect (style detected, not
		// carried) survived in exactly the layout the plugin is used in.
		const root = makeSubprojectsFixture(
			"pi-lens-ktfmt-subprojects-",
			"googleStyle()",
		);
		const filePath = writeKt(root, "app", "src", "main", "kotlin", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--google-style");
	});

	it("B2: does NOT apply a subprojects-only style to a source file of the DECLARING (root) project", async () => {
		// Gradle's `subprojects { }` configures the children, never the
		// project it is written in. The round-1 resolver matched `ktfmt {`
		// anywhere in the root build file and handed --google-style to the
		// root's own sources — a NEW disagreement with ./gradlew ktfmtFormat
		// that the pre-#2468 bare invocation did not have.
		const root = makeSubprojectsFixture(
			"pi-lens-ktfmt-subprojects-root-",
			"googleStyle()",
		);
		const filePath = writeKt(root, "src", "main", "kotlin", "Root.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBeUndefined();
	});

	it("continues the climb past a module ktfmt { } block that declares only non-style settings", async () => {
		const root = newTmpDir("pi-lens-ktfmt-inherit-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			"ktfmt {\n  maxWidth.set(100)\n}\n",
		);
		const filePath = writeKt(moduleDir, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--google-style");
	});

	it("applies allprojects { ktfmt { } } to BOTH the declaring project and its modules", async () => {
		const root = newTmpDir("pi-lens-ktfmt-allprojects-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"allprojects {\n  ktfmt {\n    kotlinLangStyle()\n  }\n}\n",
		);
		const moduleDir = path.join(root, "app");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(moduleDir, "build.gradle.kts"),
			'plugins {\n  kotlin("jvm")\n}\n',
		);
		const moduleFile = writeKt(moduleDir, "src", "Main.kt");
		const rootFile = writeKt(root, "src", "Root.kt");

		expect(await resolveKtfmtGradleStyle(moduleFile, path.dirname(root))).toBe(
			"--kotlinlang-style",
		);
		expect(await resolveKtfmtGradleStyle(rootFile, path.dirname(root))).toBe(
			"--kotlinlang-style",
		);
	});

	it("F3: a block calling both style functions resolves to the LAST call, as Gradle does", async () => {
		// `googleStyle()` and `kotlinLangStyle()` are plain setters on
		// KtfmtExtension (blockIndent/continuationIndent/
		// trailingCommaManagementStrategy `.set(...)`), verified against
		// cortinico/ktfmt-gradle @23bdedc8d5d641731a0cf128f1a386d5a127ce4e —
		// so the LAST call in the block body is the one whose values survive.
		// Round 1 returned the first recognized call instead.
		const root = newTmpDir("pi-lens-ktfmt-lastcall-");
		fs.writeFileSync(
			path.join(root, "build.gradle.kts"),
			"ktfmt {\n  googleStyle()\n  kotlinLangStyle()\n}\n",
		);
		const filePath = writeKt(root, "src", "Main.kt");

		const resolved = await resolveKtfmtGradleStyle(
			filePath,
			path.dirname(root),
		);

		expect(resolved).toBe("--kotlinlang-style");
	});
});
