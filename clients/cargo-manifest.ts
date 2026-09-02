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
 *
 * The ONE Cargo.toml reader in the tree (#2473): `clients/review-graph/
 * workspace-modules.ts`'s `scanCargoModules`/`detectWorkspaceType` used to
 * carry an independent regex TOML reader (`extractTomlArray`/
 * `extractTomlSection`/`extractTomlString`) for module-graph construction — a
 * third copy, folded onto `readCargoPackageName`/`readCargoWorkspaceMembers`/
 * `readCargoDependencyNames` below. That fold also fixed a latent defect:
 * the old `extractTomlString` was NOT table-scoped — it scanned the whole
 * file for the first `key = "value"` line regardless of which table it fell
 * under, so a member manifest with a `name` key under an EARLIER non-package
 * table (a `[[bin]] name = "..."` or `[package.metadata.*]` block preceding
 * `[package]`) silently returned the wrong crate name. `readCargoPackageName`
 * is table-scoped via `extractTomlTableSection` like every other reader here.
 */

import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logExtension } from "./extension-log.js";
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
 * Read a crate's `[package] name`, table-scoped to the `[package]` section
 * specifically (#2473) — NOT the first `name = "..."` line in the file. A
 * member manifest commonly has other tables with their own `name` key
 * (`[[bin]] name = "..."`, `[package.metadata.*]` blocks); reading unscoped
 * silently returns whichever happens to sit first in the file.
 */
export function readCargoPackageName(content: string): string | undefined {
	const packageSection = extractTomlTableSection(content, "package");
	return parseTomlScalarString(packageSection, "name");
}

/**
 * Read `members` off a (typically root/virtual) Cargo.toml for workspace
 * expansion. Matches `parseTomlStringArray`'s existing unscoped behavior —
 * `members` has no realistic collision with another table's same-named key,
 * unlike `[package] name` above, so this stays a thin wrapper rather than
 * adding `[workspace]` table-scoping the fold didn't set out to change.
 */
export function readCargoWorkspaceMembers(content: string): string[] {
	return parseTomlStringArray(content, "members");
}

/**
 * List the dependency names declared directly under `[dependencies]` (key
 * only — not the version/spec value, which may be a bare string, an inline
 * table, or workspace-inherited).
 */
export function readCargoDependencyNames(content: string): string[] {
	const section = extractTomlTableSection(content, "dependencies");
	const names: string[] = [];
	for (const rawLine of section.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		const match = line.match(/^([A-Za-z0-9_-]+)\s*=/);
		if (match) names.push(match[1]);
	}
	return names;
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

/**
 * rustfmt's `--edition` is a closed enum — 2015/2018/2021/2024 as of rustfmt
 * itself, NOT any four-digit string. A manifest typo (`edition = "2019"`) or
 * an edition newer than the installed rustfmt understands would otherwise be
 * passed straight through `--edition`, and rustfmt rejects an edition it
 * doesn't recognize outright — turning EVERY `.rs` format into a hard
 * `outcome: "failed"` where the pre-#2466 bare command formatted fine (#2466
 * review round 2, F2). When Rust stabilizes a new edition, append it to this
 * set — rustfmt's own enum is the forcing function for this list, not a
 * pattern match on digit count.
 */
const SUPPORTED_RUSTFMT_EDITIONS = new Set(["2015", "2018", "2021", "2024"]);

/**
 * Validate a manifest-read edition value against rustfmt's actual enum
 * before letting a caller pass it through `--edition`. A defined-but-invalid
 * value (as opposed to "no edition found at all") is a config anomaly worth
 * a debug trail, not a silent swap to `undefined` — logs the rejected value
 * so a future report of "rustfmt still not carrying edition X" has the exact
 * string that got refused.
 */
function validatedEdition(
	value: string | undefined,
	filePath: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (SUPPORTED_RUSTFMT_EDITIONS.has(value)) return value;
	logExtension({
		subsystem: "format",
		message:
			"resolveCargoPackageEdition: manifest edition is not a rustfmt-supported value; falling back to the static rustfmt command",
		level: "debug",
		metadata: { rejectedEdition: value, filePath },
	});
	return undefined;
}

/** Read `[workspace.package] edition` out of a manifest that declares it. */
function readWorkspacePackageEdition(content: string): string | undefined {
	const workspaceSection = extractTomlTableSection(
		content,
		"workspace.package",
	);
	return parseTomlScalarString(workspaceSection, "edition");
}

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
 *   equivalent):
 *   - First checks whether the package's OWN manifest also declares
 *     `[workspace]` — a root crate can be its own workspace root (`[package]`
 *     + `[workspace]` + `[workspace.package]` all in one file, a documented,
 *     common Cargo shape) — before climbing past it (#2466 review round 2,
 *     F1).
 *   - Otherwise climbs ancestors — same home-ceiling guard — for the nearest
 *     one that DECLARES `[workspace]` (Cargo's own workspace-root rule, not
 *     merely the nearest ancestor Cargo.toml: an intermediate manifest for an
 *     unrelated plain package is skipped, not treated as the answer — #2466
 *     review round 2, F1), then reads that root's `[workspace.package]
 *     edition`.
 * - Every edition value (direct or inherited) is checked against rustfmt's
 *   actual enum (`SUPPORTED_RUSTFMT_EDITIONS`), not just "looks like four
 *   digits" (#2466 review round 2, F2).
 * - Returns `undefined` on any miss (unreadable manifest, no `[package]`
 *   table, unsupported/invalid value, unresolved inheritance): callers fall
 *   back to their pre-existing default argv rather than guessing.
 *
 * `homeDir` defaults to `os.homedir()` and exists as a parameter so tests can
 * inject a nearer ceiling and prove the guard actually stops a climb (#2466
 * review round 2, F5) — production callers never pass it.
 */
export async function resolveCargoPackageEdition(
	filePath: string,
	homeDir: string = os.homedir(),
): Promise<string | undefined> {
	const startDir = path.dirname(path.resolve(filePath));
	const packageDir = findNearestMarkerRoot(startDir, ["Cargo.toml"], {
		homeDir,
	});
	if (!packageDir) return undefined;

	const packageContent = await readTextFileOrUndefined(
		path.join(packageDir, "Cargo.toml"),
	);
	if (packageContent === undefined) return undefined;

	const packageSection = extractTomlTableSection(packageContent, "package");
	const direct = parseTomlScalarString(packageSection, "edition");
	if (direct !== undefined) return validatedEdition(direct, filePath);

	if (!isTomlKeyWorkspaceInherited(packageSection, "edition")) return undefined;

	// The package's own manifest may ALSO be the workspace root — check it
	// before climbing so this common shape doesn't fall through to searching
	// ancestors for a `[workspace.package]` that's actually right here.
	if (extractTomlTableSection(packageContent, "workspace") !== "") {
		return validatedEdition(
			readWorkspacePackageEdition(packageContent),
			filePath,
		);
	}

	let current = path.dirname(packageDir);
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) return undefined;
		const ancestorContent = await readTextFileOrUndefined(
			path.join(current, "Cargo.toml"),
		);
		// Cargo's own rule: the workspace root is the nearest ancestor
		// Cargo.toml that DECLARES `[workspace]`. An intermediate manifest for
		// an unrelated package (no `[workspace]` table) is not it — keep
		// climbing past it instead of stopping here.
		if (
			ancestorContent !== undefined &&
			extractTomlTableSection(ancestorContent, "workspace") !== ""
		) {
			return validatedEdition(
				readWorkspacePackageEdition(ancestorContent),
				filePath,
			);
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}
