/**
 * Cross-subsystem drift guards for the canonical language registry (#2424).
 *
 * Seven extension-keyed tables used to answer "what language is this file",
 * four of them hand-copied from each other, and the only guard relating any two
 * was lsp-capable-seam-coverage's A<->B check. These are the guards for the
 * consolidated shape: every consumer is a projection of
 * clients/language-registry.ts, and a hand-edit at a consumer (or a registry
 * entry no consumer can reach) fails here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	SNAPSHOT_PATH,
} from "../../scripts/gen-language-snapshot.mjs";
import {
	detectFileKind,
	type FileKind,
	KIND_EXTENSIONS,
	SPECIAL_FILENAMES,
} from "../../clients/file-kinds.js";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import {
	EXTENSION_TO_GRAMMAR,
	EXTENSION_TO_LSP_ID,
	extensionsForLanguage,
	extensionsForLanguageToken,
	GRAMMAR_TO_EXTENSIONS,
	grammarExtensionsOf,
	KIND_TO_GRAMMAR,
	type LanguageEntry,
	LANGUAGES,
	lspLanguageId,
	PINNED_LANGUAGE_IDS,
	resolveLanguage,
} from "../../clients/language-registry.js";
import { LANGUAGE_EXTENSIONS } from "../../clients/lsp/language.js";
import { tsLangForFile } from "../../clients/module-report.js";
import { TREE_SITTER_EXT_TO_LANG } from "../../clients/project-diagnostics/scanner.js";
import { readExpansionLanguage } from "../../clients/read-expansion.js";
import { mapKindToTreeSitterLanguage } from "../../clients/review-graph/builder.js";
import { FORMATTER_POLICY_BY_EXTENSION } from "../../clients/tool-policy.js";
import { EXT_TO_LANG } from "../../clients/tree-sitter-shared.js";
import { getSymbolQueryLanguages } from "../../clients/tree-sitter-symbol-extractor.js";

/**
 * Extensions the registry owns that file-kinds.ts does NOT classify into a
 * FileKind. Every one is a recorded gap in A, not a registry invention: the
 * PHP alias extensions and the config/notation formats below reach the LSP and
 * tree-sitter seams but never became KIND_EXTENSIONS members. Pinned so a new
 * gap has to be argued for.
 */
const KIND_GAPS = [
	".adb",
	".ads",
	".astro",
	".cbl",
	".cob",
	".erl",
	".f",
	".f90",
	".f95",
	".gql",
	".graphql",
	".hrl",
	".jl",
	".mod",
	".pas",
	".php3",
	".php4",
	".php5",
	".phtml",
	".pl",
	".pm",
	".pp",
	".proto",
	".r",
	".ron",
	".sc",
	".scala",
	".sum",
	".sv",
	".typ",
	".typc",
	".v",
	".vhd",
	".vhdl",
];

/**
 * Extensions the formatter policy keys on that no language table has ever
 * classified: the Elixir template family and Arduino sketches. #2424 binds the
 * formatter table's VOCABULARY to the registry but reconciling the policy
 * itself is an explicit non-goal, so these are pinned rather than invented into
 * registry entries — a NEW unowned formatter extension still fails the guard.
 */
const FORMATTER_ONLY_EXTENSIONS = [".eex", ".heex", ".ino", ".leex"];

const sample = (extension: string) => `sample${extension}`;

const registryExtensions = LANGUAGES.flatMap((entry) => entry.extensions);

describe("language registry invariants", () => {
	it("pins the LanguageId inventory", () => {
		expect(LANGUAGES.map((entry) => entry.id).sort()).toEqual(
			[...PINNED_LANGUAGE_IDS].sort(),
		);
	});

	it("gives every extension exactly one owner", () => {
		const owners = new Map<string, string[]>();
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				owners.set(extension, [...(owners.get(extension) ?? []), entry.id]);
			}
		}
		const duplicated = [...owners.entries()].filter(
			([, ids]) => ids.length > 1,
		);
		expect(
			duplicated.map(([extension, ids]) => `${extension}: ${ids.join(", ")}`),
			"extension(s) claimed by more than one registry entry",
		).toEqual([]);
	});

	// #2424 review, S5: the sibling of the per-extension guard above. Exact
	// filenames resolve BEFORE extensions in `resolveLanguage`, so two entries
	// claiming one basename is the same silent-shadowing defect with a higher
	// blast radius — `BY_FILENAME` keeps whichever entry the LANGUAGES array
	// happens to visit last, and every consumer of that filename flips language
	// on an unrelated re-sort.
	it("gives every exact filename exactly one owner", () => {
		const owners = new Map<string, string[]>();
		for (const entry of LANGUAGES) {
			for (const filename of entry.filenames ?? []) {
				const key = filename.toLowerCase();
				owners.set(key, [...(owners.get(key) ?? []), entry.id]);
			}
		}
		const duplicated = [...owners.entries()].filter(
			([, ids]) => ids.length > 1,
		);
		expect(
			duplicated.map(([filename, ids]) => `${filename}: ${ids.join(", ")}`),
			"filename(s) claimed by more than one registry entry",
		).toEqual([]);
	});

	it("keeps every extension lowercase and dot-prefixed", () => {
		const malformed = registryExtensions.filter(
			(extension) =>
				!extension.startsWith(".") || extension !== extension.toLowerCase(),
		);
		expect(malformed).toEqual([]);
	});

	it("has no unreachable entry", () => {
		const unreachable = LANGUAGES.filter(
			(entry) =>
				entry.extensions.length === 0 && (entry.filenames ?? []).length === 0,
		);
		expect(
			unreachable.map((entry) => entry.id),
			"registry entr(ies) reachable from no extension and no filename",
		).toEqual([]);
	});

	it("keeps grammarExtensions a subset of the entry's extensions", () => {
		const stray = LANGUAGES.flatMap((entry) =>
			(entry.grammarExtensions ?? []).filter(
				(extension) => !entry.extensions.includes(extension),
			),
		);
		expect(stray).toEqual([]);
	});

	it("declares a grammar for every entry that wires extensions to one", () => {
		const missing = LANGUAGES.filter(
			(entry) => entry.grammarExtensions !== undefined && !entry.grammar,
		);
		expect(missing.map((entry) => entry.id)).toEqual([]);
	});

	it("marks kindFallback only where a kind has several owners", () => {
		const owners = new Map<FileKind, LanguageEntry[]>();
		for (const entry of LANGUAGES) {
			if (!entry.kind) continue;
			owners.set(entry.kind, [...(owners.get(entry.kind) ?? []), entry]);
		}
		const bogus = LANGUAGES.filter(
			(entry) =>
				entry.kindFallback &&
				(!entry.kind || (owners.get(entry.kind) ?? []).length < 2),
		);
		expect(bogus.map((entry) => entry.id)).toEqual([]);
		for (const [kind, list] of owners) {
			const fallbacks = list.filter((entry) => entry.kindFallback);
			expect(
				fallbacks.length,
				`kind ${kind} has ${fallbacks.length} kindFallback entries`,
			).toBeLessThan(2);
		}
	});

	it("resolves filenames before extensions", () => {
		expect(resolveLanguage("Makefile")?.id).toBe("shell");
		expect(resolveLanguage("CMakeLists.txt")?.id).toBe("cmake");
		expect(resolveLanguage("infra/terragrunt.hcl")?.id).toBe("terragrunt");
		// The basename PATTERNS in file-kinds.ts (Dockerfile.<suffix>) are the
		// last resort, mapped through the kind they classify into.
		expect(resolveLanguage("infra/Dockerfile.dev")?.id).toBe("dockerfile");
		expect(resolveLanguage("src/App.tsx")?.id).toBe("typescriptreact");
	});

	it("agrees with detectFileKind on every extension it owns", () => {
		const conflicts: string[] = [];
		const gaps: string[] = [];
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				const kind = detectFileKind(sample(extension));
				if (kind === undefined) {
					gaps.push(extension);
				} else if (kind !== entry.kind) {
					conflicts.push(`${extension}: registry ${entry.kind}, A ${kind}`);
				}
			}
		}
		expect(conflicts, "registry/FileKind disagreement").toEqual([]);
		expect(gaps.sort(), "unrecorded FileKind gap").toEqual(
			[...KIND_GAPS].sort(),
		);
	});

	it("owns every KIND_EXTENSIONS extension exactly once, with the same kind", () => {
		const missing: string[] = [];
		const mismatched: string[] = [];
		for (const [kind, extensions] of Object.entries(KIND_EXTENSIONS)) {
			for (const extension of extensions) {
				const owners = LANGUAGES.filter((entry) =>
					entry.extensions.includes(extension),
				);
				if (owners.length !== 1) {
					missing.push(`${extension} (${owners.length} owners)`);
					continue;
				}
				if (owners[0].kind !== kind) {
					mismatched.push(`${extension}: ${owners[0].kind} != ${kind}`);
				}
			}
		}
		expect(
			missing,
			"KIND_EXTENSIONS extension(s) without one registry owner",
		).toEqual([]);
		expect(mismatched).toEqual([]);
	});

	it("covers every SPECIAL_FILENAMES kind", () => {
		const unresolved = SPECIAL_FILENAMES.filter(
			({ kind }) => !LANGUAGES.some((entry) => entry.kind === kind),
		);
		expect(unresolved.map(({ pattern }) => pattern.source)).toEqual([]);
	});
});

describe("language registry <-> grammar manifest", () => {
	it("names only grammars that ship as wasm", () => {
		const unknown = LANGUAGES.filter(
			(entry) => entry.grammar && !(entry.grammar in LANGUAGE_TO_GRAMMAR),
		);
		expect(
			unknown.map((entry) => `${entry.id} -> ${entry.grammar}`),
			"registry grammar(s) with no LANGUAGE_TO_GRAMMAR entry",
		).toEqual([]);
	});

	it("reaches every LANGUAGE_TO_GRAMMAR key from some registry entry", () => {
		const reachable = new Set(
			LANGUAGES.map((entry) => entry.grammar).filter(Boolean),
		);
		const orphaned = Object.keys(LANGUAGE_TO_GRAMMAR).filter(
			(grammar) => !reachable.has(grammar),
		);
		expect(
			orphaned,
			"grammar wasm(s) no registry entry can reach (tsx/bash/vue were exactly this before #2424)",
		).toEqual([]);
	});
});

describe("consumer projections track the registry", () => {
	it("projects LSP language ids (clients/lsp/language.ts)", () => {
		expect(LANGUAGE_EXTENSIONS).toEqual({ ...EXTENSION_TO_LSP_ID });
		for (const entry of LANGUAGES) {
			for (const extension of entry.extensions) {
				expect(LANGUAGE_EXTENSIONS[extension], `LSP id for ${extension}`).toBe(
					lspLanguageId(entry),
				);
			}
		}
	});

	it("projects the ext -> grammar map (clients/tree-sitter-shared.ts)", () => {
		expect(EXT_TO_LANG).toEqual({ ...EXTENSION_TO_GRAMMAR });
		for (const entry of LANGUAGES) {
			for (const extension of grammarExtensionsOf(entry)) {
				expect(EXT_TO_LANG[extension], `grammar for ${extension}`).toBe(
					entry.grammar,
				);
			}
		}
	});

	it("projects the project scanner's map (project-diagnostics/scanner.ts)", () => {
		expect(TREE_SITTER_EXT_TO_LANG).toEqual({ ...EXTENSION_TO_GRAMMAR });
	});

	it("projects read expansion's map (clients/read-expansion.ts)", () => {
		for (const extension of Object.keys(EXTENSION_TO_GRAMMAR)) {
			expect(
				readExpansionLanguage(sample(extension)),
				`read expansion grammar for ${extension}`,
			).toBe(EXTENSION_TO_GRAMMAR[extension]);
		}
	});

	it("projects the kind -> grammar answer (review-graph + module-report)", () => {
		const symbolGrammars = new Set(getSymbolQueryLanguages());
		for (const extension of registryExtensions) {
			const path = sample(extension);
			const kind = detectFileKind(path);
			const expected =
				kind && KIND_TO_GRAMMAR[kind]
					? (EXTENSION_TO_GRAMMAR[extension] ?? KIND_TO_GRAMMAR[kind])
					: undefined;
			const wanted =
				expected && symbolGrammars.has(expected) ? expected : undefined;
			expect(
				mapKindToTreeSitterLanguage(kind, path),
				`review-graph grammar for ${extension}`,
			).toBe(wanted);
			// module-report answers identically for every kind but jsts, which it
			// resolves by path with a typescript default.
			if (kind !== "jsts") {
				expect(
					tsLangForFile(path, kind),
					`module-report grammar for ${extension}`,
				).toBe(wanted);
			}
		}
	});

	it("splits cxx headers the way both kind-keyed consumers used to inline", () => {
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.c")).toBe("c");
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.h")).toBe("c");
		expect(mapKindToTreeSitterLanguage("cxx", "src/main.cpp")).toBe("cpp");
		// The module-interface / Objective-C tail has no extension wiring and
		// falls back to the kind's declared grammar.
		expect(mapKindToTreeSitterLanguage("cxx", "src/view.mm")).toBe("cpp");
		expect(tsLangForFile("src/main.h", "cxx")).toBe("c");
		expect(tsLangForFile("src/view.mm", "cxx")).toBe("cpp");
	});

	it("keeps jsts resolving by path, never by kind", () => {
		expect(KIND_TO_GRAMMAR.jsts).toBeUndefined();
		expect(mapKindToTreeSitterLanguage("jsts", "src/App.tsx")).toBeUndefined();
		expect(tsLangForFile("src/App.tsx", "jsts")).toBe("tsx");
		expect(tsLangForFile("src/main.js", "jsts")).toBe("javascript");
		expect(tsLangForFile("src/App.vue", "jsts")).toBe("typescript");
	});

	// #2424 review, S2. `clients/lens-engine.ts` carried a NINTH hand-written
	// language -> extensions table for symbol_search's `lang` filter, keyed by
	// the ast_grep_search token vocabulary (tools/shared.ts's LANGUAGES) and
	// drifted from the registry in five places. It is now a projection via
	// `extensionsForLanguageToken`; these are that projection's guards.
	describe("symbol_search lang filter (clients/lens-engine.ts)", () => {
		// The token vocabulary symbol_search documents, mirrored (not imported —
		// clients/ never reaches into tools/). Every one must still select a
		// non-empty extension set, so folding the table cannot silently make a
		// documented `lang` value inert.
		const AST_GREP_LANG_TOKENS = [
			"bash",
			"c",
			"cpp",
			"csharp",
			"css",
			"elixir",
			"go",
			"haskell",
			"html",
			"java",
			"javascript",
			"json",
			"kotlin",
			"lua",
			"nix",
			"php",
			"python",
			"ruby",
			"rust",
			"scala",
			"swift",
			"tsx",
			"typescript",
			"yaml",
		];

		it("resolves every documented lang token to a non-empty extension set", () => {
			const inert = AST_GREP_LANG_TOKENS.filter(
				(token) => extensionsForLanguageToken(token).length === 0,
			);
			expect(
				inert,
				"lang token(s) that select no file at all after the registry fold",
			).toEqual([]);
		});

		it("resolves a token by grammar name first, then by canonical id", () => {
			// Grammar-spelled tokens (how ast_grep_search names them).
			expect(extensionsForLanguageToken("bash")).toEqual(
				GRAMMAR_TO_EXTENSIONS.bash,
			);
			expect(extensionsForLanguageToken("tsx")).toEqual([".tsx"]);
			// Id-spelled tokens for languages with no grammar at all.
			expect(extensionsForLanguageToken("haskell")).toEqual(
				extensionsForLanguage("haskell"),
			);
			// Id-derived sets keep the entry's declaration order; grammar-derived
			// ones are deduped and sorted (two entries can share a grammar).
			expect(extensionsForLanguageToken("scala")).toEqual([".scala", ".sc"]);
			// An unknown token selects nothing rather than everything.
			expect(extensionsForLanguageToken("solidity")).toEqual([]);
			expect(extensionsForLanguageToken("brainfuck")).toEqual([]);
		});

		it("groups every entry sharing a grammar under that grammar", () => {
			for (const [grammar, extensions] of Object.entries(
				GRAMMAR_TO_EXTENSIONS,
			)) {
				const expected = new Set(
					LANGUAGES.filter((entry) => entry.grammar === grammar).flatMap(
						(entry) => entry.extensions,
					),
				);
				expect(
					new Set(extensions),
					`extensions for grammar ${grammar}`,
				).toEqual(expected);
			}
			// `javascript` is the grouping case: two entries (javascript and
			// javascriptreact) share one grammar.
			expect(GRAMMAR_TO_EXTENSIONS.javascript).toContain(".jsx");
			expect(GRAMMAR_TO_EXTENSIONS.javascript).toContain(".mjs");
		});

		/**
		 * The five reconciled rows, pinned as old -> new so the decision is a
		 * review artifact and not an accident of the fold. Every narrowing is a
		 * language with no `SYMBOL_QUERIES` entry, so no real hit can be hidden:
		 * scss/less/jsonc files never parse under the css/json grammars and
		 * neither css nor json has symbol queries at all.
		 */
		it("pins the reconciled lang -> extension decisions", () => {
			// Narrowed: .scss/.less are their own registry entries with no grammar.
			expect(extensionsForLanguageToken("css")).toEqual([".css"]);
			// Narrowed: .jsonc is its own entry with no grammar.
			expect(extensionsForLanguageToken("json")).toEqual([".json", ".json5"]);
			// Widened: the registry owns php's four alias extensions.
			expect(extensionsForLanguageToken("php")).toEqual([
				".php",
				".php3",
				".php4",
				".php5",
				".phtml",
			]);
			// Widened: the registry owns .ru (Rack config).
			expect(extensionsForLanguageToken("ruby")).toContain(".ru");
			// Widened: shell's .zsh, and the full cxx extension set for cpp.
			expect(extensionsForLanguageToken("bash")).toContain(".zsh");
			expect(extensionsForLanguageToken("cpp")).toContain(".ixx");
			// Dropped: no registry entry, no wasm grammar, no napi binding, no
			// symbol queries — a .sol file can never carry an indexed symbol.
			expect(LANGUAGES.some((entry) => entry.extensions.includes(".sol"))).toBe(
				false,
			);
		});
	});

	it("keeps the formatter policy table inside the registry's vocabulary", () => {
		const unknown = [...FORMATTER_POLICY_BY_EXTENSION.keys()].filter(
			(extension) => !resolveLanguage(sample(extension)),
		);
		expect(
			unknown.sort(),
			"formatter policy extension(s) no registry entry owns (#2424 non-goal: the policy VALUES stay in tool-policy.ts, only the vocabulary is bound)",
		).toEqual([...FORMATTER_ONLY_EXTENSIONS].sort());
	});
});

describe("language-identity golden snapshot", () => {
	// The fixture is the before/after table #2424 reconciled against: every
	// consumer's answer for every extension in the union of the old tables.
	// Regenerate with `node scripts/gen-language-snapshot.mjs` and justify the
	// diff; an unexplained row here is exactly the drift this slice removed.
	it("matches the committed fixture", () => {
		const fixture = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		expect(buildSnapshot()).toEqual(fixture);
	});
});
