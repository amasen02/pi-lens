// flake-shape: real-process-spawn — the published manifest can only be observed by running the real `npm pack` (prepack/postpack are npm lifecycle hooks; nothing in-process reproduces them faithfully).
/**
 * The tarball's package.json must not carry devDependencies (2026-09-03):
 * pi supplies host-provided packages with `npm install --no-save` into the
 * installed extension, npm's resolver then walks the dev peer graph, and
 * `@vitejs/devtools@0.7.1` / `vitest@5.0.0` crash npm 10.9.8 in #loadPeerSet.
 * `scripts/strip-dev-deps-for-pack.mjs` strips them in `prepack` and restores
 * them in `postpack`; this test observes the REAL `npm pack` output.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { stripForPack } from "../scripts/strip-dev-deps-for-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	name: string;
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	scripts: Record<string, string>;
};

describe("published manifest carries no devDependencies", () => {
	it("stripForPack drops exactly devDependencies and nothing else", () => {
		const input = {
			name: "x",
			version: "1.0.0",
			dependencies: { a: "1" },
			devDependencies: { vitest: "^4" },
			scripts: { prepack: "p" },
		};
		const out = stripForPack(input);
		expect("devDependencies" in out).toBe(false);
		expect(out).toEqual({
			name: "x",
			version: "1.0.0",
			dependencies: { a: "1" },
			scripts: { prepack: "p" },
		});
	});

	it("prepack strips and postpack restores, wired in package.json", () => {
		expect(pkg.scripts.prepack).toBe(
			"node scripts/strip-dev-deps-for-pack.mjs --strip",
		);
		expect(pkg.scripts.postpack).toBe(
			"node scripts/strip-dev-deps-for-pack.mjs --restore",
		);
		expect(
			pkg.devDependencies && Object.keys(pkg.devDependencies).length,
		).toBeGreaterThan(0);
	});

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pack-"));
	afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it(
		"the real `npm pack` tarball's package.json has no devDependencies, and the working manifest is restored",
		{ timeout: 180_000 },
		() => {
			const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
			const lockBefore = fs.readFileSync(
				path.join(root, "package-lock.json"),
				"utf8",
			);
			const npm = process.platform === "win32" ? "npm.cmd" : "npm";
			// Not `--json`: `prepare` also runs on pack and its scripts write to stdout
			// (setup-git-hooks on a fresh CI checkout), which corrupts the JSON payload.
			execFileSync(npm, ["pack", "--pack-destination", tmp], {
				cwd: root,
				encoding: "utf8",
				shell: process.platform === "win32",
				timeout: 180_000,
				stdio: ["ignore", "ignore", "inherit"],
			});
			const filename = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
			if (!filename) throw new Error("npm pack produced no tarball");
			// tar with cwd + a relative path: GNU/bsd tar misread `C:...` as a remote host spec.
			const manifest = execFileSync(
				"tar",
				["-xzOf", filename, "package/package.json"],
				{ cwd: tmp, encoding: "utf8" },
			);
			const packed = JSON.parse(manifest) as {
				devDependencies?: unknown;
				dependencies?: unknown;
				name: string;
			};
			expect(packed.name).toBe(pkg.name);
			expect(packed.devDependencies).toBeUndefined();
			expect(packed.dependencies).toEqual(pkg.dependencies);
			// postpack put the working manifest back, byte for byte.
			expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
				before,
			);
			expect(fs.existsSync(path.join(root, ".pack-backup"))).toBe(false);
			// npm re-syncs the lock from the stripped manifest during pack; postpack must put it back too.
			expect(
				fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
			).toBe(lockBefore);
		},
	);
});
