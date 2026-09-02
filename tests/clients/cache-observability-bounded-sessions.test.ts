/**
 * #2442: behavior-preservation for the two per-session bounded caches in
 * clients/cache-observability.ts — `attributionBySession` (true LRU, migrated
 * to BoundedLruCache) and `prefixHashBySession` (FIFO, write-refresh,
 * migrated to BoundedFifoMap). Both share `MAX_TRACKED_SESSIONS`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_TRACKED_SESSIONS,
	_attributionBySessionHasForTests,
	_prefixHashBySessionHasForTests,
	_recordSessionHashForTests,
	_touchAttributionForTests,
	resetCachePrefixObservation,
} from "../../clients/cache-observability.js";

afterEach(() => resetCachePrefixObservation());

describe("#2442 attributionBySession (true LRU — every touch refreshes recency)", () => {
	it("evicts the single oldest key once filled past capacity", () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			_touchAttributionForTests(`session-${i}`);
		}
		expect(_attributionBySessionHasForTests("session-0")).toBe(true);

		_touchAttributionForTests("session-overflow");

		expect(_attributionBySessionHasForTests("session-0")).toBe(false);
		expect(_attributionBySessionHasForTests("session-1")).toBe(true);
	});

	it("repeated access keeps a key alive past what FIFO order alone would allow (red on an accidental FIFO substitution)", () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			_touchAttributionForTests(`hot-${i}`);
		}
		// Re-touch the oldest key repeatedly: true LRU moves it to MRU, so it
		// must survive an overflow that would otherwise target it as oldest.
		for (let i = 0; i < 5; i++) _touchAttributionForTests("hot-0");

		_touchAttributionForTests("hot-overflow");

		expect(_attributionBySessionHasForTests("hot-0")).toBe(true);
		expect(_attributionBySessionHasForTests("hot-1")).toBe(false);
	});
});

describe("#2442 prefixHashBySession (FIFO, write-refresh)", () => {
	// Every production caller of this cache both reads and re-writes on the
	// same call (see observeCachePrefix), so there is no reachable "pure
	// read that must not reorder" case to test separately here — the write-
	// refresh behavior below IS the full production access pattern.
	it("evicts the single oldest key once filled past capacity", () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			_recordSessionHashForTests(`session-${i}`, `hash-${i}`);
		}
		expect(_prefixHashBySessionHasForTests("session-0")).toBe(true);

		_recordSessionHashForTests("session-overflow", "hash-overflow");

		expect(_prefixHashBySessionHasForTests("session-0")).toBe(false);
		expect(_prefixHashBySessionHasForTests("session-1")).toBe(true);
	});

	it("a re-record of an already-resident key refreshes recency", () => {
		for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
			_recordSessionHashForTests(`refresh-${i}`, `hash-${i}`);
		}
		_recordSessionHashForTests("refresh-0", "hash-updated"); // re-record: refresh

		_recordSessionHashForTests("refresh-overflow", "hash-overflow");

		expect(_prefixHashBySessionHasForTests("refresh-0")).toBe(true);
		expect(_prefixHashBySessionHasForTests("refresh-1")).toBe(false);
	});
});
