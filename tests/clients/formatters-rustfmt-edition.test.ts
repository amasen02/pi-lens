/**
 * #2466: `clients/formatters.ts` invoked bare `rustfmt <file>` with no
 * `--edition`, so rustfmt parses under its own default edition instead of
 * the file's actual Cargo package edition — rejecting valid newer-edition
 * (e.g. Rust 2024) syntax under an older default.
 *
 * These tests call `rustfmtFormatter.resolveCommand` directly (the same
 * pattern as `formatters-stylua-project-binary.test.ts`) so they exercise
 * the real edition-resolution code path (`resolveCargoPackageEdition` in
 * `clients/cargo-manifest.ts`), not a spawn mock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rustfmtFormatter } from "../../clients/formatters.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const tmpDirs: string[] = [];

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

describe("rustfmtFormatter — Cargo edition carriage (#2466)", () => {
	it("passes --edition from the nearest package's [package] table", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-edition-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			tmpDir,
		);

		// The load-bearing assertion: removing the `--edition 2024` carriage
		// from the fix collapses this back to ["rustfmt", filePath] and this
		// line goes red.
		expect(resolved).toEqual(["rustfmt", "--edition", "2024", filePath]);
	});

	it("resolves inherited edition from [workspace.package] when the package uses edition.workspace = true", async () => {
		const wsRoot = newTmpDir("pi-lens-rustfmt-ws-");
		fs.writeFileSync(
			path.join(wsRoot, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/demo"]\n\n[workspace.package]\nedition = "2021"\n',
		);
		const memberDir = path.join(wsRoot, "crates", "demo");
		fs.mkdirSync(memberDir, { recursive: true });
		fs.writeFileSync(
			path.join(memberDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\nedition.workspace = true\n',
		);
		const filePath = path.join(memberDir, "src", "lib.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "pub fn x() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			memberDir,
		);

		expect(resolved).toEqual(["rustfmt", "--edition", "2021", filePath]);
	});

	it("falls back to the static command (null) when no Cargo.toml is found", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-noedition-");
		const filePath = path.join(tmpDir, "loose.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			tmpDir,
		);

		expect(resolved).toBeNull();
	});

	it("falls back to the static command when the package has no edition and does not inherit one", async () => {
		const tmpDir = newTmpDir("pi-lens-rustfmt-noeditionkey-");
		fs.writeFileSync(
			path.join(tmpDir, "Cargo.toml"),
			'[package]\nname = "demo"\nversion = "0.1.0"\n',
		);
		const filePath = path.join(tmpDir, "src", "main.rs");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "fn main() {}\n");

		const resolved = await rustfmtFormatter.resolveCommand?.(
			filePath,
			tmpDir,
		);

		expect(resolved).toBeNull();
	});
});
