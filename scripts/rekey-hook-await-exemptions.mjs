#!/usr/bin/env node
/**
 * Mechanically re-keys `EXEMPT_SITES` in
 * `tests/config/hook-await-bounds.test.ts` after a merge shifts lines near a
 * flagged hook-await or hand-rolled-race site (#2530 round 3 F6).
 *
 * Every key in that table is content-derived (`stableOccurrenceKey` plus a
 * two-line neighbourhood, see `tests/support/hook-await-scan.ts`), which
 * means a line inserted immediately above or below a flagged occurrence
 * re-keys it even though the occurrence itself did not move or change. That
 * is by design (#2475 — content keys, never line numbers), but it means an
 * unrelated PR's merge can turn a handful of the 187+ entries stale without
 * touching this file at all: the guard test then fails, printing the NEW key
 * for each now-unaccounted occurrence, and someone has to paste 1-3 keys in
 * by hand per touched site. This script does that mechanically instead,
 * for the WHOLE table at once, and REFUSES to touch anything it cannot
 * match with certainty.
 *
 * ## How matching works, and why it does not need git history
 *
 * Every key already carries its own file and (where the detector found one)
 * enclosing-symbol identity in plain text: `rel#symbol:hash~context` or
 * `rel#hash~context` (`race:` on hand-rolled-race keys). That identity is
 * exactly the same for an occurrence before and after a line-shifting edit
 * — only the hash and the context suffix change. So this script:
 *
 * 1. Parses every key straight out of `EXEMPT_SITES`'s source text, in
 *    declaration order.
 * 2. Runs the SAME detector `tests/config/hook-await-bounds.test.ts` uses
 *    (imported from `tests/support/hook-await-scan.ts` — the shared module
 *    that exists specifically so this script and the guard test can never
 *    drift apart) against the CURRENT tree, producing the live occurrence
 *    list in scan order (file-sorted, then line-ascending — the same order
 *    `scanFiles` has always produced).
 * 3. Groups both lists by identity (`rel[#symbol]`, namespaced by the
 *    `race:` prefix) and, for every group where the OLD count equals the
 *    NEW count, zips them pairwise (declaration order <-> scan order) to
 *    build an old-key -> new-key map.
 * 4. Refuses to rewrite ANYTHING if any group's count differs — that means
 *    an occurrence was actually added or removed near a symbol, which is a
 *    judgement call for a human (add or delete an EXEMPT_SITES entry),
 *    not a mechanical rename.
 *
 * A vitest test file cannot be `import()`ed by a bare `node` process (its
 * top-level `describe()`/`it()` calls need a running vitest worker), which
 * is exactly why the detector lives in `tests/support/hook-await-scan.ts`
 * and not in the test file itself.
 *
 * Usage:
 *   node scripts/rekey-hook-await-exemptions.mjs            # report only
 *   node scripts/rekey-hook-await-exemptions.mjs --write    # rewrite the file
 */

import { register } from "node:module";
import * as path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

register(
	pathToFileURL(
		path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"lib/ts-sibling-loader.mjs",
		),
	),
	import.meta.url,
);

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const TEST_FILE = path.join(
	REPO_ROOT,
	"tests/config/hook-await-bounds.test.ts",
);

const {
	DEFINITION_FILE,
	findHandRolledRaceLines,
	findUnboundedAwaitLines,
	hookPathFiles,
	scanFiles,
	shippedSourceFiles,
} = await import(
	pathToFileURL(path.join(REPO_ROOT, "tests/support/hook-await-scan.ts")).href
);

const WRITE = process.argv.includes("--write");

/** Extract every `EXEMPT_SITES` key, in declaration order, from the raw test source. */
function parseOldKeys(source) {
	const startMarker =
		"const EXEMPT_SITES: Readonly<Record<string, SweepExemption>> = {";
	const start = source.indexOf(startMarker);
	if (start < 0) {
		throw new Error(
			`${TEST_FILE}: could not find the EXEMPT_SITES declaration`,
		);
	}
	const bodyStart = start + startMarker.length;
	// Depth-count braces from the object's own opening `{` to find its match,
	// so this does not depend on the table's total length staying the same.
	let depth = 1;
	let i = bodyStart;
	for (; i < source.length && depth > 0; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") depth--;
	}
	const body = source.slice(bodyStart, i - 1);
	const keys = [];
	// A top-level key is a quoted string immediately followed (across
	// whitespace/newlines, prettier wraps long keys onto their own line)
	// by `{` — the start of that entry's `SweepExemption` object.
	const KEY_PATTERN = /"((?:race:)?[^"\\]+)":\s*\{/g;
	for (const match of body.matchAll(KEY_PATTERN)) keys.push(match[1]);
	return keys;
}

/** `rel[#symbol]`, namespaced by the `race:` prefix — stable across a re-hash. */
function identityOf(key) {
	const prefix = key.startsWith("race:") ? "race:" : "";
	const rest = key.slice(prefix.length);
	const hashIndex = rest.indexOf("#");
	if (hashIndex < 0) return prefix + rest; // defensive; every key has a `#` today
	const rel = rest.slice(0, hashIndex);
	const afterHash = rest.slice(hashIndex + 1);
	const colonIndex = afterHash.indexOf(":");
	const symbol = colonIndex < 0 ? undefined : afterHash.slice(0, colonIndex);
	return symbol ? `${prefix}${rel}#${symbol}` : `${prefix}${rel}`;
}

function groupByIdentity(keys) {
	const groups = new Map();
	for (const key of keys) {
		const id = identityOf(key);
		const list = groups.get(id) ?? [];
		list.push(key);
		groups.set(id, list);
	}
	return groups;
}

function main() {
	const source = readFileSync(TEST_FILE, "utf8");
	const oldKeys = parseOldKeys(source);

	const awaits = scanFiles(
		REPO_ROOT,
		hookPathFiles(REPO_ROOT),
		findUnboundedAwaitLines,
		"",
	);
	const races = scanFiles(
		REPO_ROOT,
		shippedSourceFiles(REPO_ROOT),
		findHandRolledRaceLines,
		"race:",
		(rel) => rel === DEFINITION_FILE,
	);
	const newKeys = [...awaits.occurrences, ...races.occurrences].map(
		(o) => o.key,
	);

	const oldGroups = groupByIdentity(oldKeys);
	const newGroups = groupByIdentity(newKeys);

	const allIds = new Set([...oldGroups.keys(), ...newGroups.keys()]);
	const mismatches = [];
	const mapping = new Map();
	for (const id of allIds) {
		const oldList = oldGroups.get(id) ?? [];
		const newList = newGroups.get(id) ?? [];
		if (oldList.length !== newList.length) {
			mismatches.push(
				`  ${id}: table has ${oldList.length}, scan has ${newList.length}`,
			);
			continue;
		}
		for (let i = 0; i < oldList.length; i++)
			mapping.set(oldList[i], newList[i]);
	}

	const tableKeysWithNoScanMatch = oldKeys.filter(
		(k) => !mapping.has(k),
	).length;
	const newKeySet = new Set(newKeys);
	const mappedNewKeys = new Set(mapping.values());
	const scanKeysAbsentFromTable = newKeys.filter(
		(k) => !mappedNewKeys.has(k),
	).length;

	console.log(`exemption keys in table: ${oldKeys.length}`);
	console.log(`scan produced mappings:  ${newKeys.length}`);
	console.log(`unique NEW keys:         ${newKeySet.size}`);
	console.log(`table keys with no scan match: ${tableKeysWithNoScanMatch}`);
	console.log(`scan keys absent from table:   ${scanKeysAbsentFromTable}`);

	if (mismatches.length > 0) {
		console.error(
			"\nRefusing to rewrite — these identities need a human decision:",
		);
		console.error(mismatches.join("\n"));
		console.error(
			"\nEach one is either a NEW occurrence near this symbol (add an " +
				"EXEMPT_SITES entry) or one that was removed (wrap it in bounded() " +
				"and delete its entry) — not a mechanical rename.",
		);
		process.exitCode = 1;
		return;
	}

	const changed = [...mapping.entries()].filter(
		([oldKey, newKey]) => oldKey !== newKey,
	);
	if (changed.length === 0) {
		console.log("\n0 keys need rewriting.");
		return;
	}

	console.log(`\n${changed.length} key(s) would be rewritten:`);
	for (const [oldKey, newKey] of changed)
		console.log(`  ${oldKey}\n    -> ${newKey}`);

	if (!WRITE) {
		console.log("\nRe-run with --write to apply.");
		return;
	}

	let rewritten = source;
	for (const [oldKey, newKey] of changed) {
		const needle = `"${oldKey}":`;
		if (!rewritten.includes(needle)) {
			throw new Error(
				`could not find the exact key text to replace: ${needle}`,
			);
		}
		rewritten = rewritten.replace(needle, `"${newKey}":`);
	}
	writeFileSync(TEST_FILE, rewritten);
	console.log(`\nrewrote ${changed.length} exemption key(s)`);
}

main();
