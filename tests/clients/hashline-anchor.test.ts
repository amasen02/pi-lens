import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetHashlineAnchorCacheForTests,
	computeHashlineAnchors,
	normalizeHashlineAnchorToken,
	resolveHashlineAnchor,
	xxh32Bytes,
} from "../../clients/hashline-anchor.js";

/**
 * #2423 review round 1, finding F1.
 *
 * `clients/hashline-anchor.ts` is a port of another project's hash function, so
 * the only test that means anything is one against that project's own output.
 * `tests/fixtures/hashline-edit-pro/anchor-vectors.json` was produced by
 * RUNNING pi-hashline-edit-pro's `_lineHashesPure` with the real `xxhash-wasm`
 * (see the sibling `generate-anchor-vectors.mjs`), at the upstream commit the
 * fixture names. If either side drifts, these cases go red instead of pi-lens
 * silently attributing an edit to the wrong lines.
 */
const VECTORS = JSON.parse(
	fs.readFileSync(
		path.resolve(
			import.meta.dirname,
			"..",
			"fixtures",
			"hashline-edit-pro",
			"anchor-vectors.json",
		),
		"utf8",
	),
) as {
	upstream: { commit: string; repo: string; generatedWith: string };
	xxh32: Array<{ input: string; h32: number }>;
	lineAnchors: Record<string, { content: string; hashes: string[] }>;
};

describe("#2423 hashline-edit-pro anchor algorithm", () => {
	it("names the upstream commit the vectors came from", () => {
		expect(VECTORS.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(VECTORS.upstream.repo).toContain("pi-hashline-edit-pro");
		expect(VECTORS.upstream.generatedWith).toContain("xxhash-wasm");
	});

	it("reproduces xxhash-wasm's h32 for every vector", () => {
		// Non-empty floor: an empty vector table would make this pass vacuously.
		expect(VECTORS.xxh32.length).toBeGreaterThanOrEqual(8);
		const mismatches = VECTORS.xxh32
			.filter(
				({ input, h32 }) => xxh32Bytes(Buffer.from(input, "utf8")) !== h32,
			)
			.map(({ input }) => input.slice(0, 40));
		expect(mismatches).toEqual([]);
	});

	it("reproduces the extension's per-line anchors for every fixture file", () => {
		expect(Object.keys(VECTORS.lineAnchors).length).toBeGreaterThanOrEqual(8);
		for (const [name, { content, hashes }] of Object.entries(
			VECTORS.lineAnchors,
		)) {
			expect(computeHashlineAnchors(content), name).toEqual(hashes);
		}
	});

	it("covers the cases a naive port gets wrong", () => {
		// Collision probing: duplicate line content must NOT produce duplicate
		// anchors, and the upstream fixture pins the exact probe sequence.
		const duplicates = VECTORS.lineAnchors.duplicates!;
		expect(new Set(duplicates.hashes).size).toBe(duplicates.hashes.length);
		// An empty file is one empty line, not zero lines.
		expect(VECTORS.lineAnchors.emptyFile!.hashes).toHaveLength(1);
		// The 500-byte source cap has to cut on a code-point boundary.
		expect(VECTORS.lineAnchors.longMultibyteLine).toBeDefined();
		expect(VECTORS.lineAnchors.astralAndTrim).toBeDefined();
	});
});

describe("#2423 hashline anchor tokens", () => {
	it("accepts a bare three-char base62 anchor and nothing else", () => {
		expect(normalizeHashlineAnchorToken("aB3")).toBe("aB3");
		expect(normalizeHashlineAnchorToken("  aB3  ")).toBe("aB3");
		expect(normalizeHashlineAnchorToken("123")).toBe("123");
		// The decimal form the first cut of the adapter assumed is NOT an anchor.
		expect(normalizeHashlineAnchorToken("9")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("12")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("1234")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("12: const x = 1;")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("aB3│const x = 1;")).toBeUndefined();
		expect(normalizeHashlineAnchorToken("a-3")).toBeUndefined();
		expect(normalizeHashlineAnchorToken(12)).toBeUndefined();
		expect(normalizeHashlineAnchorToken(undefined)).toBeUndefined();
	});
});

describe("#2423 resolving an anchor against a file", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		_resetHashlineAnchorCacheForTests();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-anchor-"));
		file = path.join(dir, "sample.ts");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		_resetHashlineAnchorCacheForTests();
	});

	function write(content: string): string[] {
		fs.writeFileSync(file, content, "utf8");
		return computeHashlineAnchors(content)!;
	}

	it("resolves a unique anchor to its 1-based line", () => {
		const anchors = write("alpha\nbeta\ngamma\ndelta\n");
		expect(resolveHashlineAnchor(file, anchors[2]!)).toEqual({ line: 3 });
		expect(resolveHashlineAnchor(file, ` ${anchors[0]!} `)).toEqual({
			line: 1,
		});
	});

	it("reports a stale anchor instead of guessing a line", () => {
		const anchors = write("alpha\nbeta\ngamma\n");
		const stale = anchors[1]!;
		write("alpha\ndelta\nepsilon\nzeta\n");
		_resetHashlineAnchorCacheForTests();
		const resolved = resolveHashlineAnchor(file, stale);
		// `beta` is gone, so its anchor either matches nothing or (astronomically
		// unlikely) some other line. What must never happen is a claim about the
		// line it USED to be on.
		expect(resolved.line === undefined || resolved.line !== 2).toBe(true);
	});

	it("reports a non-anchor and an unreadable file rather than throwing", () => {
		write("alpha\n");
		expect(resolveHashlineAnchor(file, "12").failure).toBe("not_an_anchor");
		expect(
			resolveHashlineAnchor(path.join(dir, "nope.ts"), "aB3").failure,
		).toBe("file_unreadable");
	});

	it("re-reads the file after it changes on disk", () => {
		const first = write("alpha\nbeta\ngamma\n");
		expect(resolveHashlineAnchor(file, first[0]!)).toEqual({ line: 1 });
		// Same path, new content: a memo keyed only by path would answer 1 again
		// for an anchor that has moved to line 3.
		const second = write("zeta\neta\nalpha\n");
		fs.utimesSync(
			file,
			new Date(Date.now() + 4000),
			new Date(Date.now() + 4000),
		);
		expect(resolveHashlineAnchor(file, second[2]!)).toEqual({ line: 3 });
	});

	it("normalizes CRLF and a BOM the way the extension does", () => {
		const anchors = computeHashlineAnchors("alpha\nbeta\ngamma\n")!;
		fs.writeFileSync(file, "﻿alpha\r\nbeta\r\ngamma\r\n", "utf8");
		expect(resolveHashlineAnchor(file, anchors[1]!)).toEqual({ line: 2 });
	});
});
