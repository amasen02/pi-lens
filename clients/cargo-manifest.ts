/**
 * Minimal Cargo.toml reading — table-section slicing plus string-array and
 * scalar-string parsing.
 *
 * Single source of truth (AGENTS.md: "a hand-maintained list that mirrors a
 * registry is a defect"; the same rule applies to a second regex TOML
 * reader). `extractTomlTableSection`/`parseTomlStringArray` originated in
 * `clients/lsp/server.ts`'s rust-analyzer workspace-root hoisting
 * (#1671/#1693) and now live here so `clients/formatters.ts`'s rustfmt
 * `--edition` resolution (#2466) reuses the exact same parser instead of a
 * second hand-rolled one. `clients/lsp/server.ts` re-imports them from here.
 */

import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findNearestMarkerRoot, isAtOrAboveHomeDir } from "./path-utils.js";

export async function readTextFileOrUndefined(
	filePath: string,
): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Slice out ONE top-level TOML table's raw body — from its `[name]` heading
 * to the next top-level `[...]`/`[[...]]` heading or EOF. `members`/`exclude`
 * must be read from the `[workspace]` table specifically: `[package]` has its
 * OWN `exclude` key (the standard cargo-publish exclude list, conventionally
 * written above `[workspace]` in a virtual-manifest-less root crate), and a
 * whole-file regex would misread it as workspace membership (#1671 F4).
 */
export function extractTomlTableSection(
	content: string,
	tableName: string,
): string {
	const heading = new RegExp(`^\\[${tableName}\\][ \\t]*(?:#.*)?$`, "m");
	const match = heading.exec(content);
	if (!match) return "";
	const rest = content.slice(match.index + match[0].length);
	const nextHeading = rest.match(/^\[{1,2}[^\]]+\]{1,2}[ \t]*(?:#.*)?$/m);
	return nextHeading?.index !== undefined
		? rest.slice(0, nextHeading.index)
		: rest;
}

export function parseTomlStringArray(content: string, key: string): string[] {
	const match = content.match(
		new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\]`, "m"),
	);
	if (!match) return [];
	return [...match[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) =>
		(m[1] ?? m[2] ?? "").trim(),
	);
}

/**
 * Read a scalar `key = "value"` / `key = 'value'` line out of a TOML table
 * section. Anchored to line-start so `swift-edition = "..."` never matches a
 * `key` of `edition`, and a dotted-key inheritance line (`edition.workspace =
 * true`) never matches either — the literal key is immediately followed by
 * `=`, not `.`.
 */
export function parseTomlScalarString(
	content: string,
	key: string,
): string | undefined {
	const match = content.match(
		new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)')`, "m"),
	);
	if (!match) return undefined;
	return match[1] ?? match[2];
}

/**
 * True when `key` is declared as workspace-inherited: the dotted-key form
 * (`edition.workspace = true`) or the inline-table form
 * (`edition = { workspace = true }`).
 */
export function isTomlKeyWorkspaceInherited(
	content: string,
	key: string,
): boolean {
	const dotted = new RegExp(
		`^[ \\t]*${key}\\.workspace[ \\t]*=[ \\t]*true`,
		"m",
	);
	const inline = new RegExp(
		`^[ \\t]*${key}[ \\t]*=[ \\t]*\\{[^}\\n]*\\bworkspace[ \\t]*=[ \\t]*true`,
		"m",
	);
	return dotted.test(content) || inline.test(content);
}

const FOUR_DIGIT_EDITION = /^\d{4}$/;

/**
 * Resolve the four-digit `edition` for the Cargo package that owns
 * `filePath`, so a formatter/build tool that needs it doesn't default to an
 * older edition than the source actually uses (#2466 — rustfmt silently
 * rejecting valid Rust 2024 syntax under an older default edition).
 *
 * - Finds the nearest readable `Cargo.toml` from `filePath` via the shared
 *   `findNearestMarkerRoot` walker (home-ceiling guarded, depth-capped —
 *   AGENTS.md walk-confinement; never a private walk-up loop).
 * - Reads `[package] edition` directly when present.
 * - When the package declares `edition.workspace = true` (or the inline-table
 *   equivalent), continues climbing ancestors — same home-ceiling guard — for
 *   the nearest `[workspace.package] edition`.
 * - Returns `undefined` on any miss (unreadable manifest, no `[package]`
 *   table, non-four-digit value, unresolved inheritance): callers fall back
 *   to their pre-existing default argv rather than guessing.
 */
export async function resolveCargoPackageEdition(
	filePath: string,
): Promise<string | undefined> {
	const startDir = path.dirname(path.resolve(filePath));
	const packageDir = findNearestMarkerRoot(startDir, ["Cargo.toml"]);
	if (!packageDir) return undefined;

	const packageContent = await readTextFileOrUndefined(
		path.join(packageDir, "Cargo.toml"),
	);
	if (packageContent === undefined) return undefined;

	const packageSection = extractTomlTableSection(packageContent, "package");
	const direct = parseTomlScalarString(packageSection, "edition");
	if (direct !== undefined) {
		return FOUR_DIGIT_EDITION.test(direct) ? direct : undefined;
	}

	if (!isTomlKeyWorkspaceInherited(packageSection, "edition")) return undefined;

	const homeDir = os.homedir();
	let current = path.dirname(packageDir);
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) return undefined;
		const ancestorContent = await readTextFileOrUndefined(
			path.join(current, "Cargo.toml"),
		);
		if (ancestorContent !== undefined) {
			const workspaceSection = extractTomlTableSection(
				ancestorContent,
				"workspace.package",
			);
			const inherited = parseTomlScalarString(workspaceSection, "edition");
			return inherited !== undefined && FOUR_DIGIT_EDITION.test(inherited)
				? inherited
				: undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}
