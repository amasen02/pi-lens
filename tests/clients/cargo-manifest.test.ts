/**
 * Direct unit coverage for `clients/cargo-manifest.ts`'s shared TOML-reading
 * primitives, added in PR #2480 review round 2. The pre-fold `extractTomlArray`/
 * `extractTomlSection`/`extractTomlString` this file's `extractTomlTableSection`/
 * `parseTomlStringArray` replaced (#2473) stripped `#`-to-EOL comments per line
 * and `.trim()`ed each line before comparing a heading — two behaviors the
 * fold's single multi-line-regex rewrite silently dropped:
 *
 * - F1: `parseTomlStringArray` harvested every quoted string inside a `[ … ]`
 *   body INCLUDING ones on a commented-out line, because the array-body regex
 *   spans the whole bracketed region in one shot with no per-line comment pass.
 * - F2: `extractTomlTableSection`'s heading/terminator regexes were anchored
 *   at column 0 (`^\[`), so an indented (but valid) TOML heading either failed
 *   to match at all (heading case) or failed to terminate the previous
 *   table's slice (sub-table terminator case). The SAME `[ \t]*` anchor fix
 *   is also what makes a CRLF manifest read correctly — ECMAScript's
 *   multiline `$`/`^` already treat a bare `\r` as a line terminator on its
 *   own, so the CRLF test below passes even without the `\r\n`→`\n`
 *   normalize `clients/cargo-manifest.ts` also runs (kept as defensive
 *   belt-and-braces, not a fix for a real match failure — review round 3
 *   correction).
 * - F4: `readCargoWorkspaceMembers` read `members` unscoped — the first
 *   `members = [...]` line anywhere in the file, not specifically the one
 *   under `[workspace]` — the exact "same-named key under an unrelated
 *   table" defect shape `readCargoPackageName` was already fixed for.
 * - Review round 3, F1: `extractTomlTableSection` returned `""` for BOTH
 *   "table absent" and "table present but empty" — see the
 *   `extractTomlTableSection` presence-vs-content describe block below.
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	extractTomlTableSection,
	hasCargoWorkspaceTable,
	parseTomlStringArray,
	readCargoWorkspaceExclude,
	readCargoWorkspaceMembers,
} from "../../clients/cargo-manifest.js";
import {
	clientSourceFiles,
	clientsRelative,
} from "../support/session-state-scan.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

describe("parseTomlStringArray comment stripping (review round 2, F1)", () => {
	it("does not harvest a quoted string from a commented-out array entry", () => {
		const content = [
			"members = [",
			'    "crates/kept",',
			'    # "crates/commented-out",',
			'    "crates/also-kept",',
			"]",
		].join("\n");
		expect(parseTomlStringArray(content, "members")).toEqual([
			"crates/kept",
			"crates/also-kept",
		]);
	});

	it("drops an entirely commented-out array key line", () => {
		const content = [
			'# members = ["crates/should-not-appear"]',
			'members = ["crates/real"]',
		].join("\n");
		expect(parseTomlStringArray(content, "members")).toEqual(["crates/real"]);
	});

	it("leaves a `#` inside a quoted string alone (not a comment leader)", () => {
		const content = 'members = ["crates/foo#bar"]';
		expect(parseTomlStringArray(content, "members")).toEqual([
			"crates/foo#bar",
		]);
	});
});

describe("extractTomlTableSection indentation + CRLF (review round 2, F2)", () => {
	it("reads an indented table heading", () => {
		const content = '  [package]\n  name = "indented"\n';
		expect(extractTomlTableSection(content, "package")).toContain(
			'name = "indented"',
		);
	});

	it("terminates a table body at an indented sub-table heading", () => {
		const content = [
			"[dependencies]",
			'serde = "1.0"',
			"",
			"  [dependencies.tokio]",
			'  version = "1"',
		].join("\n");
		const section = extractTomlTableSection(content, "dependencies");
		expect(section).toContain('serde = "1.0"');
		expect(section).not.toContain("version");
	});

	it("matches a heading and reads its body across CRLF line endings", () => {
		const content = '[package]\r\nname = "crlf"\r\n';
		expect(extractTomlTableSection(content, "package")).toContain(
			'name = "crlf"',
		);
	});

	it("tolerates a trailing comment on the heading line", () => {
		const content =
			'[package] # the package table\nname = "commented-heading"\n';
		expect(extractTomlTableSection(content, "package")).toContain(
			'name = "commented-heading"',
		);
	});
});

describe("extractTomlTableSection presence vs content (review round 3, F1)", () => {
	it("returns undefined when the table is absent", () => {
		expect(
			extractTomlTableSection('[package]\nname = "x"\n', "workspace"),
		).toBeUndefined();
	});

	it('returns "" (not undefined) when the table is present but empty and sits last in the file with NO trailing newline', () => {
		const content = ["[package]", 'name = "x"', "", "[workspace]"].join("\n");
		expect(content.endsWith("\n")).toBe(false);
		expect(extractTomlTableSection(content, "workspace")).toBe("");
	});

	it('returns "" when the table heading carries a trailing comment and is immediately EOF', () => {
		const content = ["[package]", 'name = "x"', "", "[workspace] # root"].join(
			"\n",
		);
		expect(extractTomlTableSection(content, "workspace")).toBe("");
	});

	it('returns "" when the table heading has trailing whitespace and is immediately EOF', () => {
		const content = ["[package]", 'name = "x"', "", "[workspace]   "].join(
			"\n",
		);
		expect(extractTomlTableSection(content, "workspace")).toBe("");
	});
});

describe("readCargoWorkspaceMembers/readCargoWorkspaceExclude table-scoping (review round 2, F4)", () => {
	it("reads members from [workspace], not an unrelated table's same-named key", () => {
		const content = [
			"[workspace.metadata.decoy]",
			'members = ["should-not-appear"]',
			"",
			"[workspace]",
			'members = ["crates/real"]',
		].join("\n");
		expect(readCargoWorkspaceMembers(content)).toEqual(["crates/real"]);
	});

	it("reads exclude from [workspace], not [package]'s own exclude key", () => {
		const content = [
			"[package]",
			'exclude = ["should-not-appear"]',
			"",
			"[workspace]",
			'exclude = ["crates/skip"]',
		].join("\n");
		expect(readCargoWorkspaceExclude(content)).toEqual(["crates/skip"]);
	});
});

describe("hasCargoWorkspaceTable (#2498)", () => {
	it("is true when [workspace] is present", () => {
		expect(hasCargoWorkspaceTable('[package]\nname = "x"\n\n[workspace]\n')).toBe(
			true,
		);
	});

	it("is true for a present-but-empty [workspace] table (review round 3, F1 shape)", () => {
		const content = ["[package]", 'name = "x"', "", "[workspace]"].join("\n");
		expect(content.endsWith("\n")).toBe(false);
		expect(hasCargoWorkspaceTable(content)).toBe(true);
	});

	it("is false when [workspace] is absent", () => {
		expect(hasCargoWorkspaceTable('[package]\nname = "x"\n')).toBe(false);
	});

	it("is false for an unrelated same-named table (e.g. [workspace.metadata])", () => {
		// `[workspace.metadata]` is its own table; `extractTomlTableSection`
		// anchors the heading to the exact table name, so a sub-table alone
		// must not read as the parent table being present.
		expect(
			hasCargoWorkspaceTable('[workspace.metadata]\nfoo = "bar"\n'),
		).toBe(false);
	});
});

/**
 * The "one Cargo.toml reader" guard, extended for #2498: `clients/lsp/
 * server.ts:2599` hand-rolled `/^\s*\[workspace\]/m.test(parentCargoContent)`
 * four lines above `cargoWorkspaceDeclaresMember`, which #2480 had already
 * converted to the shared readers above. A hand-rolled `\[workspace\]` regex
 * is the exact signature of that class of defect (AGENTS.md: "a hand-
 * maintained list that mirrors a registry is a defect" — the same rule
 * applies to a second regex TOML reader), so this sweep fails the build the
 * moment a future edit reintroduces one anywhere outside this file.
 */
describe("no hand-rolled [workspace]-table regex outside cargo-manifest.ts (#2498)", () => {
	/**
	 * A literal backslash immediately before `[`/`]` is not something ordinary
	 * prose writes — TOML syntax in a comment reads `[workspace]`, never
	 * `\[workspace\]` — so this substring, surviving a comment-blanking pass,
	 * is specific to an actual regex pattern (literal or `new RegExp(...)`)
	 * that tests for the table heading.
	 */
	function hasWorkspaceRegexLiteral(strippedSource: string): boolean {
		return strippedSource.includes("\\[workspace\\]");
	}

	it("detects the exact pre-#2498 defect shape (mutation check)", () => {
		// `clients/lsp/server.ts:2599`, verbatim, before the fix. Proves the
		// detector actually fires before the real-tree sweep below is trusted
		// to mean anything.
		const mutant = [
			"if (",
			"\tparentCargoContent !== undefined &&",
			"\t/^\\s*\\[workspace\\]/m.test(parentCargoContent)",
			") {",
			"}",
		].join("\n");
		expect(
			hasWorkspaceRegexLiteral(stripSource(mutant, { strings: "keep" })),
		).toBe(true);
	});

	it("a bare comment naming [workspace] does not trip the detector", () => {
		// The un-escaped form a doc comment or a TOML file actually writes.
		// Comments are blanked before the check runs, so this also proves the
		// blanking is load-bearing: without it, a doc comment quoting the
		// escaped form (as this very repo's cargo-manifest.ts does) would
		// false-positive on itself.
		const source = "// the [workspace] table\nconst x = 1;\n";
		expect(
			hasWorkspaceRegexLiteral(stripSource(source, { strings: "keep" })),
		).toBe(false);
	});

	it("clients/ carries the reader in cargo-manifest.ts only", () => {
		const files = clientSourceFiles().filter(
			(file) => clientsRelative(file) !== "cargo-manifest.ts",
		);
		assertNonEmptyScan(
			"clients/*.ts (minus cargo-manifest.ts)",
			files.length,
		);
		const offenders = files
			.filter((file) => {
				const stripped = stripSource(fs.readFileSync(file, "utf-8"), {
					strings: "keep",
				});
				return hasWorkspaceRegexLiteral(stripped);
			})
			.map(clientsRelative);
		expect(offenders).toEqual([]);
	});
});
