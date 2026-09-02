import { describe, expect, it } from "vitest";
import {
	BoundedFifoMap,
	BoundedLruCache,
} from "../../clients/bounded-cache.js";

describe("BoundedLruCache", () => {
	it("evicts the least recently used entry and allows recovery", () => {
		const cache = new BoundedLruCache<string, string>(2);
		cache.set("a", "one");
		cache.set("b", "two");
		expect(cache.get("a")).toBe("one");
		cache.set("c", "three");
		expect(cache.get("b")).toBeUndefined();
		cache.set("b", "rebuilt");
		expect(cache.get("b")).toBe("rebuilt");
	});

	it("refreshes recency on read", () => {
		const cache = new BoundedLruCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
	});

	it("set() returns the evicted keys, oldest first", () => {
		const cache = new BoundedLruCache<string, number>(2);
		expect(cache.set("a", 1)).toEqual([]);
		expect(cache.set("b", 2)).toEqual([]);
		expect(cache.set("c", 3)).toEqual(["a"]);
	});
});

describe("BoundedFifoMap (#2442)", () => {
	it("evicts the oldest INSERTION (not the least recently used) and allows recovery", () => {
		const map = new BoundedFifoMap<string, string>(2);
		map.set("a", "one");
		map.set("b", "two");
		// A read must NOT refresh recency — "a" stays the oldest even though it
		// was just read, unlike BoundedLruCache.
		expect(map.get("a")).toBe("one");
		map.set("c", "three");
		expect(map.get("a")).toBeUndefined(); // evicted despite the read above
		expect(map.get("b")).toBe("two"); // survives: it was never read, but
		// insertion order (not read order) is what matters for FIFO
		map.set("b", "rebuilt");
		expect(map.get("b")).toBe("rebuilt");
	});

	it("get() never re-inserts (insertion order stays eviction order)", () => {
		const map = new BoundedFifoMap<string, number>(2);
		map.set("a", 1);
		map.set("b", 2);
		for (let i = 0; i < 5; i++) map.get("a"); // repeated reads
		map.set("c", 3); // "a" is still the oldest insertion — evicted
		expect(map.has("a")).toBe(false);
		expect(map.has("b")).toBe(true);
	});

	it("set() on an already-present key updates in place without reordering (matches native Map#set)", () => {
		const map = new BoundedFifoMap<string, number>(3);
		map.set("a", 1);
		map.set("b", 2);
		map.set("c", 3);
		map.set("a", 100); // update, not append — "a" stays the oldest position
		map.set("d", 4); // pushes past capacity — evicts the oldest: "a"
		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
		expect(map.get("c")).toBe(3);
		expect(map.get("d")).toBe(4);
	});

	it("set() returns the evicted keys, oldest first", () => {
		const map = new BoundedFifoMap<string, number>(2);
		expect(map.set("a", 1)).toEqual([]);
		expect(map.set("b", 2)).toEqual([]);
		expect(map.set("c", 3)).toEqual(["a"]);
	});

	it("has/delete/clear/size/entriesArray behave as a bounded Map", () => {
		const map = new BoundedFifoMap<string, number>(5);
		map.set("a", 1);
		map.set("b", 2);
		expect(map.size).toBe(2);
		expect(map.has("a")).toBe(true);
		expect(map.entriesArray()).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(map.delete("a")).toBe(true);
		expect(map.has("a")).toBe(false);
		expect(map.size).toBe(1);
		map.clear();
		expect(map.size).toBe(0);
	});
});
