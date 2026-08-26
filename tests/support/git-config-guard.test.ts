import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync } from "./git-fixture-env.js";
import { assertCleanGitConfig, localConfigPath } from "./git-config-guard.js";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("Git contamination guard", () => {
	it.each([
		["pi-lens test", "name"],
		["t", "name"],
	])("fails on the known fixture name %j", (value) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			`[core]\n\tbare = false\n[user]\n\tname = ${value}\n`,
		);
		expect(() => assertCleanGitConfig(config)).toThrow(
			/known fixture identity/,
		);
	});

	it.each([["test@example.com"], ["t@t.t"], ["t@t.local"]])(
		"fails on the known fixture email %j",
		(value) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
			scratch.push(dir);
			const config = path.join(dir, "config");
			fs.writeFileSync(config, `[user]\n\temail = ${value}\n`);
			expect(() => assertCleanGitConfig(config)).toThrow(
				/known fixture identity/,
			);
		},
	);

	it("fails on a known fixture identity in a subsection, not only the bare user section", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, '[user "fixture"]\n\temail = t@t.t\n');
		expect(() => assertCleanGitConfig(config)).toThrow(
			/known fixture identity/,
		);
	});

	it("fails on core.bare=true", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = true\n");
		expect(() => assertCleanGitConfig(config)).toThrow(/core\.bare=true/);
	});

	it("accepts a clean non-bare config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(config, "[core]\n\tbare = false\n");
		expect(() => assertCleanGitConfig(config)).not.toThrow();
	});

	it("does not flag a maintainer's own non-fixture identity (F5 narrowing)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-guard-"));
		scratch.push(dir);
		const config = path.join(dir, "config");
		fs.writeFileSync(
			config,
			"[user]\n\tname = Apostolos Mantzaris\n\temail = ap.mantza@gmail.com\n",
		);
		expect(() => assertCleanGitConfig(config)).not.toThrow();
	});

	it("resolves a linked worktree's config to the COMMON dir, not the per-worktree gitdir (F4)", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-git-guard-wt-"),
		);
		scratch.push(root);
		const main = path.join(root, "main");
		const worktree = path.join(root, "wt");
		fs.mkdirSync(main, { recursive: true });
		gitExecFileSync("git", ["init", "-q"], { cwd: main });
		fs.writeFileSync(path.join(main, "README.md"), "seed\n");
		gitExecFileSync("git", ["add", "README.md"], { cwd: main });
		// Author via env, not `git config`, so the shared config starts clean
		// and core.bare=true below is the ONLY contamination under test.
		gitExecFileSync("git", ["commit", "-q", "-m", "seed"], {
			cwd: main,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t.t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t.t",
			},
		});
		gitExecFileSync("git", ["worktree", "add", "-q", worktree], {
			cwd: main,
		});

		// The per-worktree gitdir has no config of its own: a naive resolver
		// that stops there sees a missing file and reports clean.
		const naivePath = path.join(
			main,
			".git",
			"worktrees",
			path.basename(worktree),
			"config",
		);
		expect(fs.existsSync(naivePath)).toBe(false);

		// Contaminate the shared config the worktree actually inherits.
		gitExecFileSync("git", ["config", "core.bare", "true"], { cwd: main });

		const resolved = localConfigPath(worktree);
		expect(resolved).toBe(path.join(main, ".git", "config"));
		expect(() => assertCleanGitConfig(resolved)).toThrow(/core\.bare=true/);
	});
});
