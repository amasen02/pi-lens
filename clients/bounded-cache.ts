/** Small insertion-ordered LRU used for process-lifetime memo tables. */
export class BoundedLruCache<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly maxEntries: number) {}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	/**
	 * Insert or update `key`, moving it to the most-recently-used position.
	 * Returns the keys evicted (oldest first) to stay within capacity, if any
	 * — callers with eviction-side bookkeeping (telemetry, tombstones,
	 * resource cleanup) use the return value instead of hand-rolling
	 * `keys().next().value` (#2442).
	 */
	set(key: K, value: V): K[] {
		this.entries.delete(key);
		this.entries.set(key, value);
		const evicted: K[] = [];
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
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
 * Small insertion-ordered FIFO map used for process-lifetime memo tables
 * whose eviction order must not be perturbed by reads: unlike
 * {@link BoundedLruCache}, `get` never re-inserts, and `set` never
 * reorders an already-present key — it behaves exactly like native
 * `Map#set` on an existing key. A caller that wants a WRITE (not a read) to
 * refresh recency does its own `delete` + `set` around this map, exactly
 * as it would against a raw `Map` (#2442).
 */
export class BoundedFifoMap<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly maxEntries: number) {}

	get(key: K): V | undefined {
		return this.entries.get(key);
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	/**
	 * Insert or update `key` without reordering. Evicts the oldest
	 * (insertion-order) entries once the map exceeds capacity, returning the
	 * evicted keys (oldest first), if any.
	 */
	set(key: K, value: V): K[] {
		this.entries.set(key, value);
		const evicted: K[] = [];
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
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
