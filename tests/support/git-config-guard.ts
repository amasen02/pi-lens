import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the config file that actually governs `repoRoot`. A linked
 * worktree's `.git` file points at a per-worktree gitdir
 * (`<main>/.git/worktrees/<name>`) that has no `config` of its own — Git
 * config for a worktree lives in the COMMON dir, named by that gitdir's
 * `commondir` file. Reading the per-worktree gitdir's (nonexistent) config
 * silently reports clean even when the shared config is contaminated
 * (#2163 F4: a guard run from the worktree must still see main-repo state).
 */
export function localConfigPath(repoRoot: string): string {
	const gitEntry = path.join(repoRoot, ".git");
	if (fs.existsSync(gitEntry) && fs.statSync(gitEntry).isFile()) {
		const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(gitEntry, "utf8"));
		if (match) {
			const gitDir = path.resolve(repoRoot, match[1].trim());
			const commondirFile = path.join(gitDir, "commondir");
			if (fs.existsSync(commondirFile)) {
				const commonDir = path.resolve(
					gitDir,
					fs.readFileSync(commondirFile, "utf8").trim(),
				);
				return path.join(commonDir, "config");
			}
			return path.join(gitDir, "config");
		}
	}
	return path.join(gitEntry, "config");
}

/**
 * Identities the fixture suite itself writes into a real Git config (see
 * tests/clients/metrics-history-stderr.test.ts, opaque-mutation-scan.test.ts,
 * git-tracked-ignore.test.ts, and .github/workflows/install-smoke.yml). The
 * guard flags ONLY these — a maintainer's legitimate `[user]` identity in the
 * main checkout must never trip it (#2163 F5: the prior version flagged any
 * local identity, which would red every local run once the guard actually
 * reaches the shared config via F4's commondir fix).
 */
export const KNOWN_FIXTURE_NAMES: ReadonlySet<string> = new Set([
	"pi-lens test",
	"t",
]);
export const KNOWN_FIXTURE_EMAILS: ReadonlySet<string> = new Set([
	"test@example.com",
	"t@t.t",
	"t@t.local",
]);

export function assertCleanGitConfig(configPath: string): void {
	if (!fs.existsSync(configPath)) return;
	const text = fs.readFileSync(configPath, "utf8");
	let section = "";
	let identity = false;
	let bare = false;
	for (const line of text.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]+)\]/.exec(line);
		if (header) {
			section = header[1].trim().toLowerCase().split(/\s+/)[0] ?? "";
			continue;
		}
		if (section === "user") {
			const nameMatch = /^\s*name\s*=\s*(.*?)\s*$/.exec(line);
			const emailMatch = /^\s*email\s*=\s*(.*?)\s*$/.exec(line);
			if (nameMatch && KNOWN_FIXTURE_NAMES.has(nameMatch[1])) identity = true;
			if (emailMatch && KNOWN_FIXTURE_EMAILS.has(emailMatch[1]))
				identity = true;
		}
		if (section === "core" && /^\s*bare\s*=\s*true\s*$/i.test(line))
			bare = true;
	}
	if (identity || bare) {
		throw new Error(
			`Git contamination guard failed for ${configPath}: ${identity ? "known fixture identity" : "core.bare=true"}`,
		);
	}
}

export default function teardown(): void {
	assertCleanGitConfig(localConfigPath(process.cwd()));
}
