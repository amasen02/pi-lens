/**
 * #2442: forbid a NEW hand-rolled evict-oldest block outside
 * `clients/bounded-cache.ts`.
 *
 * `clients/bounded-cache.ts` ships two small bounded collections —
 * `BoundedLruCache` (get() re-inserts) and `BoundedFifoMap` (get() never
 * re-inserts, insertion-order eviction) — built specifically so a call site
 * never has to hand-roll `const oldest = map.keys().next().value; if
 * (oldest !== undefined) map.delete(oldest);` again. #2432's round-3 review
 * named two such hand-rolled sites (`clients/hashline-anchor.ts`,
 * `clients/mutating-tool.ts`); a repo-wide sweep found the idiom 27 times.
 *
 * ## Two properties this sweep learned the hard way (#2442 review F5/F6)
 *
 * 1. **Three spellings, not one.** The first draft matched only
 *    `.keys().next().value`, so `tree-sitter-client.ts`'s two live
 *    `.entries().next().value` evictions and `debug-handles.ts`'s
 *    `for (const k of map.keys()) { …; break }` walk were invisible to a guard
 *    whose whole job was finding them. All three spellings are matched now,
 *    across `keys`/`values`/`entries` — the Set-shaped sites use `.values()`.
 * 2. **Per-OCCURRENCE, not per-FILE.** Exemptions used to name a file, so a
 *    NEW hand-rolled eviction appended to an already-exempted file passed
 *    silently — the exemption laundered it. Every flagged item is now keyed
 *    by `stableOccurrenceKey` (`tests/support/sweep-kit.ts`), so an exemption
 *    is supposed to excuse exactly one occurrence and nothing else — but the
 *    key alone cannot fully guarantee that: in a class-shaped file, every
 *    method's flagged line resolves to the SAME enclosing symbol (the class
 *    name), so two sibling methods that each flag a byte-identical line
 *    collide on one key, and one exemption would silently excuse both (#2487
 *    review F1 — the exact laundering this property exists to prevent, one
 *    layer down). `auditRegistry`'s `requireUniqueFlagged` (on by default)
 *    is what actually closes that: a duplicate flagged key fails LOUD before
 *    exemption-matching ever runs, so a real collision cannot ride through
 *    silently regardless of how the key was derived.
 * 3. **Content-keyed, not line-keyed (#2475).** The first version of property
 *    2 keyed on `path:line`, which re-keys on every unrelated line inserted
 *    ABOVE a flagged site — #2459, #2449, and #2474 each had to re-pin a line
 *    number that had nothing to do with their own change, and a textual merge
 *    of two such re-keys can silently land a WRONG number with no conflict
 *    marker. `stableOccurrenceKey` keys on the occurrence's own TEXT instead
 *    (its enclosing top-level declaration name, via `findEnclosingSymbol`,
 *    plus a short content hash of the flagged line via `lineContentHash`), so
 *    moving the site by inserting lines elsewhere in the file is a no-op for
 *    the key. Deleting or editing the flagged line still changes its key —
 *    correctly, since `auditRegistry`'s stale-exemption check must still
 *    catch an exemption whose target moved or vanished; it now reports the
 *    drift by name/hash instead of by line number.
 *
 * Built on tests/support/sweep-kit.ts, same as this repo's other
 * registered-or-fail sweeps. `EXEMPT_SITES` below is the FULL, reasoned list
 * of every remaining occurrence. A NEW site must migrate to `BoundedLruCache`
 * or `BoundedFifoMap`, or be added here with a real reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	disambiguateFlaggedKeys,
	listSourceFiles,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Spelling 1: `<container>.keys()/.values()/.entries().next().value` — pull
 * the first entry out of an insertion-ordered container. `.values()` is the
 * `Set` form, `.entries()` the form used when the eviction needs the VALUE
 * too (a compiled query to free, a WASM tree to retire).
 */
const ITERATOR_HEAD = /\.(?:keys|values|entries)\(\)\.next\(\)\.value/;

/**
 * Spelling 2: a `for (const k of container.keys())` walk that breaks out
 * early and deletes — the same evict-oldest intent written as a loop. Both
 * `break` and `.delete(` must appear within {@link FOR_OF_WINDOW} lines of
 * the `for`, because the delete frequently happens AFTER the loop
 * (`debug-handles.ts` assigns the key inside and deletes below it).
 */
const FOR_OF_ITERATOR =
	/\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+[\w$.[\]]+\.(?:keys|values|entries)\(\)\s*\)/;
const FOR_OF_WINDOW = 12;

/** The one file allowed to spell the idiom: the canonical implementation. */
const DEFINITION_FILE = "clients/bounded-cache.ts";

/**
 * `stableOccurrenceKey` output (`path#enclosingSymbol:contentHash`, or
 * `path#contentHash` with no enclosing symbol) → why this exact occurrence
 * stays hand-rolled.
 *
 * Every entry is a container shape neither bounded class covers. There are no
 * "deferred" entries left: #2442's review round migrated the three
 * `clients/review-graph/*` sites (their stated owner, the build-latch fix,
 * merged as #2446) and the four eviction-side-effect sites in
 * `tree-sitter-cache.ts` / `tree-sitter-client.ts`, which is what
 * `set()`'s `[key, value]` return exists for.
 *
 * Keys were migrated from `path:line` to `stableOccurrenceKey` by #2475. When
 * a genuine edit to the flagged line itself invalidates a key (not a line
 * inserted elsewhere — that's the churn this migration removes), the failing
 * test's `audit.problems` output prints the new key the scan now computes;
 * paste it in.
 */
const EXEMPT_SITES: Readonly<Record<string, string>> = {
	"clients/lsp/session-roots.ts#registerSessionRoot:0a69a3da":
		"Set, not Map: `sessionRoots` stores membership only, and there is no " +
		"BoundedSet in clients/bounded-cache.ts. Building one is a second " +
		"primitive with its own tests, deliberately out of #2442's scope " +
		"(the issue asks for a FIFO sibling of BoundedLruCache, a K,V map). " +
		"Named here rather than left invisible; a BoundedSet is the natural " +
		"follow-up that would clear all four Set-shaped entries at once.",
	"index.ts#ensureLSPConfigInitialized:4115f214":
		"Set, not Map: `_lspConfigInitializedCwds` is membership-only — same " +
		"reason as clients/lsp/session-roots.ts, whose SESSION_ROOT_CAP this " +
		"cap is deliberately paired with. No BoundedSet exists; see that " +
		"entry for why building one is out of #2442's scope.",
	"clients/observed-mutation.ts#noteMutationHandled:8c9e32ed":
		"Set, not Map: `handled` records only THAT a path was already recorded " +
		"through the pipeline this run — membership, no value. Migrating it to " +
		"BoundedFifoMap purely to reuse the eviction block would mean storing a " +
		"dummy value in every entry, which is a worse shape than the one line " +
		"it deletes. Same reason as the three siblings above; #2460's BoundedSet " +
		"is the follow-up that clears all four at once. The eviction is NOT " +
		"silent: it emits `observed_handled_evicted` naming the dropped path " +
		"(#2449 review round 4, S2), because dropping a mark makes pi-lens read " +
		"its own formatter output as third-party drift.",
	"clients/lsp-mutation.ts#bookkeepLspMutation:a1744d34":
		"Set, not Map: `autofixRecordedPaths` is membership-only, and it is " +
		"per-CONTEXT state (created on the mutation context, not module " +
		"scope), so it is not even process-lifetime. No BoundedSet exists; " +
		"see clients/lsp/session-roots.ts for why building one is out of " +
		"#2442's scope.",
	"clients/debug-handles.ts#recordTrackedInit:3737b5dc":
		"Not evict-OLDEST: this walk deliberately SKIPS the first " +
		"TRACKER_PROTECTED_COUNT insertion-order entries and evicts the " +
		"oldest one after them, so the earliest-created handles (the ones " +
		"most likely to be the leak under investigation) are never the ones " +
		"dropped. A protected prefix is a policy neither BoundedFifoMap nor " +
		"BoundedLruCache expresses, and encoding it into a shared primitive " +
		"for one debug-only caller is not worth the surface.",
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

/** Every hand-rolled eviction in one file, as 1-based line numbers. */
export function findEvictionLines(stripped: string): number[] {
	const lines = stripped.split("\n");
	const hits = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (ITERATOR_HEAD.test(line)) hits.add(i + 1);
		if (!FOR_OF_ITERATOR.test(line)) continue;
		const window = lines.slice(i + 1, i + 1 + FOR_OF_WINDOW).join("\n");
		if (/\bbreak\b/.test(window) && /\.delete\(/.test(window)) hits.add(i + 1);
	}
	return [...hits].sort((a, b) => a - b);
}

/** One flagged occurrence: its stable key plus a `file:line` diagnostic detail. */
interface FlaggedOccurrence {
	key: string;
	detail: string;
}

function findFlaggedOccurrences(): {
	occurrences: FlaggedOccurrence[];
	scanned: number;
} {
	const files = shippedSourceFiles();
	const occurrences: FlaggedOccurrence[] = [];
	for (const abs of files) {
		const rel = relativePosix(REPO_ROOT, abs);
		if (rel === DEFINITION_FILE) continue;
		// Strip first: an idiom named only in a comment or a string is not one.
		// Layout is preserved, so these line numbers (and the hash inputs derived
		// from them) match the raw source.
		const stripped = stripSource(fs.readFileSync(abs, "utf8"));
		const lines = stripped.split("\n");
		for (const line of findEvictionLines(stripped)) {
			occurrences.push({
				key: stableOccurrenceKey(rel, lines, line - 1),
				detail: `${rel}:${line}`,
			});
		}
	}
	return { occurrences, scanned: files.length };
}

describe("#2442 no new hand-rolled evict-oldest idiom outside bounded-cache.ts", () => {
	const { occurrences, scanned } = findFlaggedOccurrences();
	const flagged = occurrences.map((o) => o.key);

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// Vacuity guard on the DETECTOR: as of #2449's review round 4, five
		// occurrences remain (four Set-shaped, one protected-prefix policy). If
		// this drops to zero, EITHER every exemption's site was migrated (update
		// the sweep) OR the regexes broke (fix the sweep) — never assume the
		// former without checking.
		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});

	it("detects all three spellings, not just `.keys().next().value`", () => {
		// Mutation guard on the DETECTOR itself (#2442 review F5): the first
		// draft matched one spelling and silently missed the other two. Each
		// fixture below is a real shape found in this tree.
		expect(findEvictionLines("const a = m.keys().next().value;")).toEqual([1]);
		expect(findEvictionLines("const b = s.values().next().value;")).toEqual([
			1,
		]);
		expect(findEvictionLines("const c = m.entries().next().value;")).toEqual([
			1,
		]);
		expect(
			findEvictionLines(
				["for (const k of m.keys()) {", "  m.delete(k);", "  break;", "}"].join(
					"\n",
				),
			),
		).toEqual([1]);
		// A plain iteration that neither breaks nor deletes is NOT an eviction.
		expect(
			findEvictionLines(
				["for (const k of m.keys()) {", "  total += k;", "}"].join("\n"),
			),
		).toEqual([]);
	});

	it("flags per OCCURRENCE, so an exemption cannot launder a new sibling", () => {
		// #2442 review F6: exemptions used to be file-level, so appending a NEW
		// eviction to an exempted file passed. Every flagged id carries a
		// content-derived key (#2475: `path#symbol:hash` or `path#hash`, never a
		// bare line number — see `stableOccurrenceKey`).
		for (const item of flagged) {
			expect(item).toMatch(/^[\w./-]+\.ts#(?:[A-Za-z_$][\w$]*:)?[0-9a-f]{8}$/);
		}
		const exemptedFiles = new Set(
			Object.keys(EXEMPT_SITES).map((k) => k.split("#")[0]),
		);
		// Every exempted FILE still has exactly the occurrences named, no more:
		// a second, unexcused occurrence in the same file must show up as
		// unaccounted below rather than riding the file's exemption.
		for (const file of exemptedFiles) {
			const inFile = flagged.filter((f) => f.startsWith(`${file}#`));
			for (const occurrence of inFile) {
				expect(
					Object.hasOwn(EXEMPT_SITES, occurrence),
					`${occurrence} is in an exempted file but is not itself exempted`,
				).toBe(true);
			}
		}
	});

	// #2487 review F1: the test above ("flags per OCCURRENCE") is vacuous
	// against a real collision, because `expect(item).toBe(...)` compares the
	// SAME string to itself when two occurrences hash to one key — it cannot
	// distinguish "this occurrence is exempted" from "some occurrence sharing
	// this key is exempted". This test runs a REAL twin-collision fixture
	// through the actual detection pipeline (`findEvictionLines` +
	// `stableOccurrenceKey`, not a hand-typed key) and proves `auditRegistry`
	// itself refuses to let one exemption cover both — the property the
	// vacuous test above could never have caught.
	it("ATTACK_TWIN_OCCURRENCE_COLLISION (#2487 review F1): two sibling methods with an identical flagged line cannot share one exemption", () => {
		const rel = "clients/__probe_twin_cache.ts";
		const source = [
			"class ProbeTwinCache {",
			"\tevictFirst() {",
			"\t\tfor (const k of this.map.keys()) {",
			"\t\t\tthis.map.delete(k);",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"\tevictSecond() {",
			"\t\tfor (const k of this.map.keys()) {",
			"\t\t\tthis.map.delete(k);",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"}",
		].join("\n");
		const evictionLines = findEvictionLines(source);
		expect(evictionLines).toEqual([3, 9]); // both flagged by the REAL detector
		const lines = source.split("\n");
		const twinOccurrences = evictionLines.map((line) => ({
			key: stableOccurrenceKey(rel, lines, line - 1),
			detail: `${rel}:${line}`,
		}));
		// Precondition: both really do collide on one key — same enclosing
		// symbol (the class), same flagged-line text.
		expect(twinOccurrences[0]?.key).toBe(twinOccurrences[1]?.key);

		// One exemption, keyed to the shared string: pre-guard this read clean
		// (laundered); the collision guard must refuse it.
		const laundered = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: twinOccurrences,
			registered: [],
			exemptions: {
				[twinOccurrences[0]!.key]: "reviewed exemption for one occurrence",
			},
		});
		expect(laundered.problems.join("\n")).toContain("collide");

		// The remedy this sweep ships: disambiguate before exempting, and give
		// EACH occurrence its own reasoned entry. That passes.
		const disambiguated = disambiguateFlaggedKeys(twinOccurrences);
		expect(disambiguated.map((e) => e.key)).toEqual([
			twinOccurrences[0]!.key,
			`${twinOccurrences[0]!.key}#2`,
		]);
		const properlyExempted = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: disambiguated,
			registered: [],
			exemptions: {
				[disambiguated[0]!.key]: "reviewed exemption for occurrence 1 of 2",
				[disambiguated[1]!.key]: "reviewed exemption for occurrence 2 of 2",
			},
		});
		expect(properlyExempted.problems).toEqual([]);
	});

	it("every occurrence is the definition file, migrated, or exempted with a reason", () => {
		const audit = auditRegistry({
			sweepName: "bounded-eviction-idiom sweep",
			flagged: occurrences,
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
				"clients/bounded-cache.ts — both return the evicted [key, value] " +
				"pairs from set(), so eviction-side bookkeeping needs no hand-rolled " +
				"block either — or add an EXEMPT_SITES entry here (keyed by " +
				"`stableOccurrenceKey` from tests/support/sweep-kit.ts — " +
				"`path#symbol:hash` or `path#hash`, printed above) with a real " +
				"reason (see #2442's PR body verdict table for the shape of a " +
				"legitimate exemption).",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});
