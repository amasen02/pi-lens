/**
 * #2442: forbid a NEW hand-rolled `map.keys().next().value` evict-oldest
 * block outside `clients/bounded-cache.ts`.
 *
 * `clients/bounded-cache.ts` ships two small bounded collections —
 * `BoundedLruCache` (get() re-inserts) and `BoundedFifoMap` (get() never
 * re-inserts, insertion-order eviction) — built specifically so a call site
 * never has to hand-roll `const oldest = map.keys().next().value; if
 * (oldest !== undefined) map.delete(oldest);` again. #2432's round-3 review
 * named two such hand-rolled sites (`clients/hashline-anchor.ts`,
 * `clients/mutating-tool.ts`); a repo-wide sweep found the idiom 27 times.
 * #2442 migrated the sites where a plain `Map<K,V>` was doing the eviction;
 * this sweep is the recurrence guard so the idiom cannot silently return.
 *
 * Built on tests/support/sweep-kit.ts, same as this repo's other
 * registered-or-fail sweeps. `EXEMPT_SITES` below is the FULL, reasoned list
 * of every remaining occurrence: three deferred (owned by an in-flight
 * `clients/review-graph/*` build-latch fix, out of #2442's scope by explicit
 * instruction) and three "neither" verdicts (a `PathKeyedMap` variant with no
 * bounded counterpart, and `tree-sitter-cache.ts`'s WASM-retiring LRU whose
 * eviction is side-effect-coupled — see #2442's PR body verdict table for the
 * full per-site reasoning). A NEW site must migrate to `BoundedLruCache` or
 * `BoundedFifoMap`, or be added here with a real reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const EVICT_IDIOM = /\.keys\(\)\.next\(\)\.value/;

/** The one file allowed to spell the idiom: the canonical implementation. */
const DEFINITION_FILE = "clients/bounded-cache.ts";

const EXEMPT_SITES: Readonly<Record<string, string>> = {
	"clients/partial-edit-apply.ts":
		"PartialApplyRecordStore.files is a PathKeyedMap<V[]>, not a plain " +
		"Map<K,V> — its keys need write/read path normalization (AGENTS.md " +
		"defect shape 1), which neither BoundedLruCache nor BoundedFifoMap " +
		"provides. A path-key-normalizing bounded map is out of #2442's " +
		"minimal scope (issue asks for a generic K,V sibling of " +
		"BoundedLruCache, not a PathKeyedMap variant).",
	"clients/tree-sitter-cache.ts":
		"TreeCache.cache's eviction (setMaxSize AND set()) is side-effect " +
		"coupled: dropping the oldest entry must retire the WASM-heap tree " +
		"(removeEntry/retireTree, #417/#890), record ghost-eviction history " +
		"for capacity-miss detection, and bump per-outcome counters — none " +
		"of which a bare bounded map's set()/get() contract expresses. " +
		"BoundedLruCache/BoundedFifoMap intentionally stay side-effect-free; " +
		"retrofitting an eviction hook is a larger change than #2442's " +
		"migration scope. (recentlyEvicted, the OTHER map in this file, WAS " +
		"migrated to BoundedFifoMap — this exemption covers only `cache`.)",
	"clients/review-graph/builder.ts":
		"deferred: clients/review-graph/* is owned by an in-flight " +
		"build-latch fix per #2442's explicit orchestrator instruction — " +
		"left untouched to avoid colliding with that work.",
	"clients/review-graph/shared-extraction-ir.ts":
		"deferred: clients/review-graph/* is owned by an in-flight " +
		"build-latch fix per #2442's explicit orchestrator instruction — " +
		"left untouched to avoid colliding with that work.",
};

function shippedSourceFiles(): string[] {
	const files = ["clients", "tools", "mcp"].flatMap((dir) => {
		const abs = path.join(REPO_ROOT, dir);
		return fs.existsSync(abs)
			? listSourceFiles(abs, { extensions: [".ts"], skipTests: true })
			: [];
	});
	const indexTs = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files;
}

function findFlaggedFiles(): { flagged: string[]; scanned: number } {
	const files = shippedSourceFiles();
	const flagged: string[] = [];
	for (const abs of files) {
		const rel = relativePosix(REPO_ROOT, abs);
		if (rel === DEFINITION_FILE) continue;
		const stripped = stripSource(fs.readFileSync(abs, "utf8"));
		if (EVICT_IDIOM.test(stripped)) flagged.push(rel);
	}
	return { flagged, scanned: files.length };
}

describe("#2442 no new hand-rolled evict-oldest idiom outside bounded-cache.ts", () => {
	const { flagged, scanned } = findFlaggedFiles();

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// Vacuity guard on the DETECTOR: as of #2442, six files still carry the
		// idiom (three deferred, three "neither"). If this drops to zero, EITHER
		// every exemption's site was migrated (update the sweep) OR the regex
		// broke (fix the sweep) — never assume the former without checking.
		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});

	it("every occurrence is the definition file, migrated, or exempted with a reason", () => {
		const audit = auditRegistry({
			sweepName: "bounded-eviction-idiom sweep",
			flagged,
			registered: [],
			exemptions: EXEMPT_SITES,
			scannedCount: scanned,
			// Calibration: ~450 shipped .ts files across clients/tools/mcp/index.ts
			// as of #2442; half rounded down is comfortably under that.
			minScanned: 200,
			minFlagged: 1,
			remediation:
				"Migrate the site to BoundedLruCache (get() re-inserts — LRU) or " +
				"BoundedFifoMap (get() never re-inserts — FIFO) from " +
				"clients/bounded-cache.ts, or add an EXEMPT_SITES entry here with a " +
				"real reason (see #2442's PR body verdict table for the shape of a " +
				"legitimate exemption).",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});
