/**
 * #2442: behavior-preservation for `sharedLineCountCache` in
 * clients/diagnostic-line-freshness.ts, migrated from a hand-rolled
 * evict-oldest Map to BoundedFifoMap. `LineCountCache` is now a structural
 * interface (not `Map` itself) so `createLineCountCache()`'s test-isolated
 * instances stay plain, unbounded `Map`s while only the shared default is
 * bounded — see the interface's doc comment. `_seedSharedLineCountCacheForTests`
 * writes through the exact same `cache.set()` call `rememberInSharedCache`
 * uses, and `_sharedLineCountCacheHasForTests` is a `.has()` read that
 * bypasses `getCachedLineCount`'s real-stat requirement, so this proves
 * capacity eviction without 513 real files on disk.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_SHARED_CACHE_ENTRIES,
	_resetSharedLineCountCacheForTests,
	_seedSharedLineCountCacheForTests,
	_sharedLineCountCacheHasForTests,
} from "../../clients/diagnostic-line-freshness.js";

afterEach(() => _resetSharedLineCountCacheForTests());

function seed(i: number, mtimeMs = i): void {
	_seedSharedLineCountCacheForTests(`/repo/file-${i}.ts`, {
		mtimeMs,
		size: 10,
		lineCount: 1,
	});
}

describe("#2442 sharedLineCountCache (FIFO)", () => {
	it("evicts the single oldest file once filled past capacity", () => {
		for (let i = 0; i < MAX_SHARED_CACHE_ENTRIES; i++) seed(i);
		expect(_sharedLineCountCacheHasForTests("/repo/file-0.ts")).toBe(true);

		seed(MAX_SHARED_CACHE_ENTRIES); // overflow

		expect(_sharedLineCountCacheHasForTests("/repo/file-0.ts")).toBe(false);
		expect(_sharedLineCountCacheHasForTests("/repo/file-1.ts")).toBe(true);
		expect(
			_sharedLineCountCacheHasForTests(
				`/repo/file-${MAX_SHARED_CACHE_ENTRIES}.ts`,
			),
		).toBe(true);
	});

	it("a read (.has) never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_SHARED_CACHE_ENTRIES; i++) seed(i);

		for (let i = 0; i < 5; i++) {
			_sharedLineCountCacheHasForTests("/repo/file-0.ts");
		}

		seed(MAX_SHARED_CACHE_ENTRIES); // overflow

		expect(_sharedLineCountCacheHasForTests("/repo/file-0.ts")).toBe(false);
	});
});
