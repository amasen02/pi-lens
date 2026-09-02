import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CONFIG_DIAGNOSTIC_CODE_PATTERN,
	CONFIG_DIAGNOSTIC_CODES,
	CONFIG_DIAGNOSTIC_MARKER_PATTERN,
	configDiagnosticMarker,
	getConfigDiagnosticCode,
	isConfigDiagnosticCode,
	withConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * #2418 policy point 2. The namespace is APPEND-ONLY: prose may be rewritten,
 * codes may not be renumbered or removed. The pinned list below is the
 * enforcement — a renumber or a deletion turns this file red, and the only
 * legal edit is appending a new entry at the end.
 */
const PINNED_CODES = [
	"PILENS_CFG_0001",
	"PILENS_CFG_0002",
	"PILENS_CFG_0003",
] as const;

describe("config diagnostic code namespace (#2418)", () => {
	it("is append-only: every pinned code still exists, in order", () => {
		const actual = Object.keys(CONFIG_DIAGNOSTIC_CODES);
		expect(actual.slice(0, PINNED_CODES.length)).toEqual([...PINNED_CODES]);
	});

	it("only ever grows", () => {
		expect(Object.keys(CONFIG_DIAGNOSTIC_CODES).length).toBeGreaterThanOrEqual(
			PINNED_CODES.length,
		);
	});

	it("uses one code format and unique, monotonic numbers", () => {
		const codes = Object.keys(CONFIG_DIAGNOSTIC_CODES);
		expect(codes.length).toBeGreaterThan(0);
		for (const code of codes) {
			expect(code).toMatch(CONFIG_DIAGNOSTIC_CODE_PATTERN);
		}
		expect(new Set(codes).size).toBe(codes.length);
		const numbers = codes.map((code) =>
			Number(code.slice("PILENS_CFG_".length)),
		);
		for (let i = 1; i < numbers.length; i += 1) {
			expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
		}
		expect(numbers[0]).toBe(1);
	});

	it("gives every code a non-empty description", () => {
		for (const [code, description] of Object.entries(CONFIG_DIAGNOSTIC_CODES)) {
			expect(description, code).toBeTruthy();
			expect(getConfigDiagnosticCode(code)).toBe(description);
		}
	});

	it("recognizes registered codes and rejects everything else", () => {
		expect(isConfigDiagnosticCode("PILENS_CFG_0001")).toBe(true);
		expect(isConfigDiagnosticCode("PILENS_CFG_9999")).toBe(false);
		expect(isConfigDiagnosticCode("toString")).toBe(false);
		expect(isConfigDiagnosticCode(undefined)).toBe(false);
		expect(getConfigDiagnosticCode("PILENS_CFG_9999")).toBeUndefined();
	});
});

describe("config diagnostic markers (#2418)", () => {
	it("appends a greppable bracketed suffix", () => {
		const message = withConfigDiagnosticCode(
			"pi-lens: ignoring invalid LSP config a.json: bad",
			"PILENS_CFG_0001",
		);
		expect(message).toBe(
			"pi-lens: ignoring invalid LSP config a.json: bad [PILENS_CFG_0001]",
		);
		expect(message.endsWith(configDiagnosticMarker("PILENS_CFG_0001"))).toBe(
			true,
		);
	});

	it("is idempotent", () => {
		const once = withConfigDiagnosticCode("msg", "PILENS_CFG_0002");
		expect(withConfigDiagnosticCode(once, "PILENS_CFG_0002")).toBe(once);
	});

	it("round-trips through the extraction pattern", () => {
		const message = withConfigDiagnosticCode("msg", "PILENS_CFG_0003");
		const matched = CONFIG_DIAGNOSTIC_MARKER_PATTERN.exec(message);
		expect(matched?.[1]).toBe("PILENS_CFG_0003");
		expect(isConfigDiagnosticCode(matched?.[1])).toBe(true);
	});

	it("does not match a message with no marker", () => {
		expect(CONFIG_DIAGNOSTIC_MARKER_PATTERN.test("plain prose")).toBe(false);
	});
});

/**
 * The drift half: every user-facing degradation raised from a CONFIG surface
 * must carry a registered code, otherwise a user is back to matching prose.
 * Scans the config loaders themselves rather than a hand-maintained list of
 * call sites, so a new `*config*.ts` notifier is caught the day it lands.
 */
function configSurfaceSources(): Array<{ file: string; source: string }> {
	const found: Array<{ file: string; source: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (!/config/i.test(entry.name)) continue;
			found.push({
				file: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
				source: fs.readFileSync(full, "utf-8"),
			});
		}
	};
	walk(path.join(REPO_ROOT, "clients"));
	return found;
}

/** Every `notifyUserDegradation(...)` call body in a source, paren-balanced. */
function notifyCalls(source: string): string[] {
	const calls: string[] = [];
	const needle = "notifyUserDegradation(";
	let index = source.indexOf(needle);
	while (index !== -1) {
		let depth = 0;
		let end = index + needle.length - 1;
		for (; end < source.length; end += 1) {
			if (source[end] === "(") depth += 1;
			else if (source[end] === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		calls.push(source.slice(index, end + 1));
		index = source.indexOf(needle, end + 1);
	}
	return calls;
}

describe("config-surface warnings carry a stable code (#2418)", () => {
	const sources = configSurfaceSources();

	it("finds config sources to audit", () => {
		// Declared floor: an empty walk must FAIL, never read as clean. Three
		// config loaders exist today; the floor is deliberately below that so a
		// rename does not break the sweep, but a zero-file walk still does.
		assertNonEmptyScan("config-surface code audit", sources.length, 3);
	});

	it("audits at least the three known config loaders", () => {
		const files = sources.map((entry) => entry.file);
		expect(files).toContain("clients/lens-config.ts");
		expect(files).toContain("clients/project-lens-config.ts");
		expect(files).toContain("clients/lsp/config.ts");
	});

	it("passes a code on every config-surface notifyUserDegradation call", () => {
		const uncoded: string[] = [];
		let audited = 0;
		for (const { file, source } of sources) {
			for (const call of notifyCalls(source)) {
				audited += 1;
				if (!/\bcode\b/.test(call)) uncoded.push(`${file}: ${call}`);
			}
		}
		expect(audited).toBeGreaterThan(0);
		expect(uncoded).toEqual([]);
	});

	it("only references registered codes", () => {
		const referenced = new Set<string>();
		for (const { source } of sources) {
			for (const match of source.matchAll(/PILENS_CFG_\d{4}/g)) {
				referenced.add(match[0]);
			}
		}
		expect(referenced.size).toBeGreaterThan(0);
		for (const code of referenced) {
			expect(isConfigDiagnosticCode(code), code).toBe(true);
		}
	});
});
