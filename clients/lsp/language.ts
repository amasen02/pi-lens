import path from "node:path";
import {
	getLanguageId as getKindLanguageId,
	KIND_EXTENSIONS,
	SPECIAL_FILENAMES,
} from "../file-kinds.js";
import { getLspCapableKinds } from "../language-policy.js";
import { EXTENSION_TO_LSP_ID } from "../language-registry.js";

/**
 * Language ID Mappings for LSP
 *
 * Maps file extensions to LSP language identifiers.
 */

// Extension -> LSP languageId, projected from the canonical language registry
// (clients/language-registry.ts, #2424). One FileKind can span several LSP ids
// (jsts covers typescript/typescriptreact/vue, cxx covers c and cpp) and the
// protocol spells some of them differently from the canonical id
// ("shellscript", not "shell"), so the registry carries an lspId column and
// this map is a pure projection of it. These win over the derived fill-in below.
const CURATED_LANGUAGE_EXTENSIONS: Record<string, string> = EXTENSION_TO_LSP_ID;

/**
 * Curated ids plus a derived fill-in for every extension an lspCapable kind
 * registers. Before #1545 this table was hand-maintained alone and had drifted:
 * powershell had no entry at all and cxx covered a third of its extensions, so
 * `didOpen` announced those files as "plaintext". Tolerance for that varies by
 * server — json/yaml/clangd answer the same either way, a DocumentSelector
 * server may not handle the document at all — so the id is sent correctly
 * rather than relied on being ignored. A newly registered language now reaches
 * this seam by being lspCapable.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = (() => {
	const map: Record<string, string> = { ...CURATED_LANGUAGE_EXTENSIONS };
	for (const kind of getLspCapableKinds()) {
		for (const extension of KIND_EXTENSIONS[kind]) {
			map[extension] ??= getKindLanguageId(kind);
		}
	}
	return map;
})();

/**
 * file-kinds.ts's basename classifier (Makefile, Dockerfile.<suffix>,
 * CMakeLists.txt, …) matches by regex, not literal filename, so it can't be
 * flattened into LANGUAGE_EXTENSIONS' literal-key map. Derived from
 * SPECIAL_FILENAMES — the same single source of truth detectFileKind() uses —
 * filtered to lspCapable kinds so a basename pattern that classifies into an
 * lspCapable kind always resolves a language id here too (#1594).
 */
const BASENAME_LANGUAGE_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	languageId: string;
}> = (() => {
	const lspCapableKinds = new Set(getLspCapableKinds());
	return SPECIAL_FILENAMES.filter(({ kind }) => lspCapableKinds.has(kind)).map(
		({ pattern, kind }) => ({
			pattern,
			languageId: getKindLanguageId(kind),
		}),
	);
})();

function getBasenameLanguageId(base: string): string | undefined {
	return BASENAME_LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(base))
		?.languageId;
}

/**
 * Get language ID for a file path
 */
export function getLanguageId(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (ext && LANGUAGE_EXTENSIONS[ext]) {
		return LANGUAGE_EXTENSIONS[ext];
	}

	const base = path.basename(filePath);
	return (
		LANGUAGE_EXTENSIONS[base] ??
		LANGUAGE_EXTENSIONS[base.toLowerCase()] ??
		getBasenameLanguageId(base)
	);
}

/**
 * Get all extensions for a language ID
 */
export function getExtensionsForLanguage(languageId: string): string[] {
	return Object.entries(LANGUAGE_EXTENSIONS)
		.filter(([, id]) => id === languageId)
		.map(([ext]) => ext);
}
