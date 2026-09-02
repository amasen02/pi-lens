/**
 * #2468: `clients/formatters.ts` invoked bare `ktfmt <file>` with no style
 * flag, so ktfmt formatted under its own default style instead of the
 * project's actual Gradle `ktfmt { googleStyle() | kotlinLangStyle() }`
 * selection — the same manifest-detected-but-not-carried defect shape #2466
 * fixed for rustfmt `--edition`.
 *
 * The first test calls `ktfmtFormatter.resolveCommand` directly (the same
 * pattern as `formatters-rustfmt-edition.test.ts`) with a project-local PATH
 * shim so the real `which`/`where` spawn resolves `ktfmt` for real — this is
 * the load-bearing regression proof that the style flag reaches ktfmt's
 * actual argv. The remaining cases call `resolveKtfmtGradleStyle`
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
	fs.writeFileSync(filePath, isWin ? "@echo off\r\n" : "#!/bin/sh\necho fake\n");
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
			const resolved = await ktfmtFormatter.resolveCommand?.(
				filePath,
				tmpDir,
			);
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

	it("falls back when the block declares the removed dropboxStyle()", async () => {
		// dropboxStyle() was removed from ktfmt-gradle in 0.19.0 (2024-07-03,
		// "no longer supported by ktfmt") and ktfmt's own CLI never exposed a
		// --dropbox-style flag (verified against ParsedArgs.kt, v0.63). A
		// project still calling it (stale plugin / manual block) must not get
		// a guessed/nonexistent flag passed through.
		const tmpDir = newTmpDir("pi-lens-ktfmt-dropbox-");
		fs.writeFileSync(
			path.join(tmpDir, "build.gradle.kts"),
			"ktfmt {\n  dropboxStyle()\n}\n",
		);
		const filePath = path.join(tmpDir, "src", "Main.kt");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fun main() {}\n");

		const resolved = await resolveKtfmtGradleStyle(filePath);

		expect(resolved).toBeUndefined();
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
