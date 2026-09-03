/**
 * #2514: `findInNodeModules`'s ancestor walk (`clients/formatters.ts`) had no
 * HOME ceiling, so a stray `~/node_modules/.bin/oxfmt.cmd` (the home-level
 * pi-extensions manifest installs its own bins) was picked up as the
 * project's formatter on any box with a home-level `node_modules`. The same
 * unceilinged shape existed in `findInVendorBin` (`clients/formatters.ts`,
 * `vendor/bin`) and, since #2514 folds `findInNodeModules` onto the shared
 * `findLocalBinUpwards` (`clients/package-manager.ts`, also used by stylua,
 * taplo, knip, jscpd and madge), in that walker directly.
 *
 * Per #2517's per-walker policy: these are TOOL-RESOLUTION walkers, not
 * config-file lookups — escaping the project upward past HOME must mean
 * STOP, not keep reading. A `node_modules/.bin`/`vendor/bin` match found at
 * or above HOME can never be the project's own installed dependency.
 *
 * Every case here pins a FAKE `homeDir` explicitly (never the real
 * `os.homedir()`) so the test is hermetic regardless of what the running
 * box's actual home directory contains (probe hygiene: never plant fixtures
 * under the maintainer's real `$HOME`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findLocalBinUpwards } from "../../clients/package-manager.js";
import {
	_findInVendorBinForTests,
	_findInVenvForTests,
} from "../../clients/formatters.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

type Walker = (
	binary: string,
	startDir: string,
	homeDir: string,
) => Promise<string | null> | string | undefined;

interface WalkerCase {
	name: string;
	/** Directory segment(s) under a dir that make it "installed" there. */
	binSubpath: (binary: string) => string;
	walk: Walker;
}

const WALKERS: WalkerCase[] = [
	{
		name: "findLocalBinUpwards (node_modules/.bin, package-manager.ts, #2514 fold target)",
		binSubpath: (binary) => path.join("node_modules", ".bin", winName(binary)),
		walk: (binary, startDir, homeDir) =>
			findLocalBinUpwards(binary, startDir, undefined, homeDir),
	},
	{
		name: "_findInVendorBinForTests (vendor/bin, formatters.ts)",
		binSubpath: (binary) =>
			path.join(
				"vendor",
				"bin",
				process.platform === "win32" ? `${binary}.bat` : binary,
			),
		walk: (binary, startDir, homeDir) =>
			_findInVendorBinForTests(binary, startDir, homeDir),
	},
	{
		name: "_findInVenvForTests (.venv/bin, formatters.ts)",
		binSubpath: (binary) =>
			process.platform === "win32"
				? path.join(".venv", "Scripts", `${binary}.exe`)
				: path.join(".venv", "bin", binary),
		walk: (binary, startDir, homeDir) =>
			_findInVenvForTests(binary, startDir, homeDir),
	},
];

function winName(binary: string): string {
	return process.platform === "win32" ? `${binary}.cmd` : binary;
}

function plantBin(dir: string, subpath: string): void {
	const full = path.join(dir, subpath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, "#!/bin/sh\necho fake\n", { mode: 0o755 });
}

describe.each(WALKERS)("$name home ceiling (#2514)", ({ binSubpath, walk }) => {
	let tmpDir: string;

	function makeFixture() {
		const env = setupTestEnvironment("pi-lens-bin-walker-home-");
		tmpDir = env.tmpDir;
		const fakeHome = path.join(tmpDir, "home");
		const project = path.join(fakeHome, "proj");
		const nested = path.join(project, "src");
		fs.mkdirSync(nested, { recursive: true });
		return { fakeHome, project, nested };
	}

	it("a bin planted AT the home directory is not resolved from a project nested under it", async () => {
		const { fakeHome, nested } = makeFixture();
		try {
			plantBin(fakeHome, binSubpath("oxfmt"));

			const resolved = await walk("oxfmt", nested, fakeHome);

			expect(resolved ?? null).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("the project's OWN bin below HOME still resolves (~/proj/… layout)", async () => {
		const { fakeHome, project, nested } = makeFixture();
		try {
			plantBin(project, binSubpath("oxfmt"));

			const resolved = await walk("oxfmt", nested, fakeHome);

			expect(resolved).toBe(path.join(project, binSubpath("oxfmt")));
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("a cross-form (forward-slash) start directory still respects the ceiling", async () => {
		const { fakeHome, nested } = makeFixture();
		try {
			plantBin(fakeHome, binSubpath("oxfmt"));
			const crossFormNested = nested.split(path.sep).join("/");

			const resolved = await walk("oxfmt", crossFormNested, fakeHome);

			expect(resolved ?? null).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
