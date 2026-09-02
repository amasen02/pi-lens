/**
 * Small insertion-ordered FIFO map used for process-lifetime memo tables
 * whose eviction order must not be perturbed by reads: `get` never
 * re-inserts, and `set` never reorders an already-present key — it behaves
 * exactly like native `Map#set` on an existing key. A caller that wants a
 * WRITE (not a read) to refresh recency does its own `delete` + `set` around
 * this map, exactly as it would against a raw `Map` (#2442).
 *
 * {@link BoundedLruCache} extends this class and overrides exactly the two
 * methods that differ (`get` re-inserts; `set` deletes first so a write moves
 * the key to most-recently-used). Eviction, capacity and the whole `Map`-ish
 * surface live here once — the two classes shipped as near-identical copies
 * until #2442's review round flagged the duplication.
 */
export class BoundedFifoMap<K, V> {
	protected readonly entries = new Map<K, V>();
	protected maxEntries: number;

	constructor(maxEntries: number) {
		this.maxEntries = maxEntries;
	}

	get(key: K): V | undefined {
		return this.entries.get(key);
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	/**
	 * Insert or update `key` without reordering. Evicts the oldest
	 * (insertion-order) entries once the map exceeds capacity.
	 *
	 * Returns the evicted `[key, value]` pairs, oldest first — callers with
	 * eviction-side bookkeeping use the return value instead of hand-rolling
	 * `keys().next().value` (#2442). The VALUE is returned, not just the key,
	 * because the eviction-coupled sites need it: `tree-sitter-cache.ts` has to
	 * retire the dropped entry's WASM-heap tree (#417/#890) and
	 * `tree-sitter-client.ts` has to `delete()` the dropped compiled query.
	 * Handing back only the key would force those sites to read the value out
	 * of the map before eviction — i.e. to hand-roll the block this class
	 * exists to delete.
	 */
	set(key: K, value: V): Array<[K, V]> {
		this.entries.set(key, value);
		return this.evictOverflow();
	}

	/**
	 * Change the capacity ceiling, evicting down to it immediately when it
	 * shrinks. Returns the evicted `[key, value]` pairs, oldest first, on the
	 * same contract as {@link set} — a caller with a DYNAMIC cap (an env-read
	 * ceiling, `TreeCache.setMaxSize`) needs the shrink to free the same
	 * resources an ordinary overflow frees.
	 */
	setMaxEntries(maxEntries: number): Array<[K, V]> {
		this.maxEntries = maxEntries;
		return this.evictOverflow();
	}

	/** Current capacity ceiling. */
	getMaxEntries(): number {
		return this.maxEntries;
	}

	/** Drop oldest-first until within capacity. The one eviction block. */
	protected evictOverflow(): Array<[K, V]> {
		const evicted: Array<[K, V]> = [];
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.entries().next().value as [K, V] | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest[0]);
			evicted.push(oldest);
		}
		return evicted;
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}
	clear(): void {
		this.entries.clear();
	}
	get size(): number {
		return this.entries.size;
	}
	keys(): IterableIterator<K> {
		return this.entries.keys();
	}
	values(): IterableIterator<V> {
		return this.entries.values();
	}
	entriesArray(): Array<[K, V]> {
		return [...this.entries.entries()];
	}
	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries[Symbol.iterator]();
	}
}

/**
 * Small insertion-ordered LRU used for process-lifetime memo tables. Same
 * bounded-`Map` surface as {@link BoundedFifoMap}; the only two differences
 * are overridden below.
 */
export class BoundedLruCache<K, V> extends BoundedFifoMap<K, V> {
	/**
	 * Read and promote to most-recently-used.
	 *
	 * A stored `undefined` value is NOT promoted — the hit is indistinguishable
	 * from a miss on this signature, and pre-#2442 `BoundedLruCache` behaved
	 * the same way. No caller stores `undefined`; the note exists so a future
	 * one does not assume otherwise.
	 */
	override get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	/** Insert or update `key`, moving it to the most-recently-used position. */
	override set(key: K, value: V): Array<[K, V]> {
		this.entries.delete(key);
		return super.set(key, value);
	}
}
