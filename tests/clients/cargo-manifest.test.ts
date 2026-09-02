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
 *   table's slice (sub-table terminator case); the CRLF `\r` also sat between
 *   the matched heading text and the `$` anchor, breaking the match outright.
 * - F4: `readCargoWorkspaceMembers` read `members` unscoped — the first
 *   `members = [...]` line anywhere in the file, not specifically the one
 *   under `[workspace]` — the exact "same-named key under an unrelated
 *   table" defect shape `readCargoPackageName` was already fixed for.
 */
import { describe, expect, it } from "vitest";
import {
	extractTomlTableSection,
	parseTomlStringArray,
	readCargoWorkspaceExclude,
	readCargoWorkspaceMembers,
} from "../../clients/cargo-manifest.js";

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
