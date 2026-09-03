---
section: Changed
---

- **`BoundedSet` sibling in `clients/bounded-cache.ts`; four hand-rolled membership-Set caps migrated (refs #2460)** — `BoundedFifoMap`/`BoundedLruCache` (#2442) cover the K,V shape only, so the process-lifetime membership-only Set caps that #2442 could not migrate stayed hand-rolled and exempted in `tests/config/bounded-eviction-idiom-sweep.test.ts`. `BoundedSet<T>` adds the same insert-order eviction contract (`add()`/`setMaxEntries()` return the evicted values, oldest first) with no dummy-value tax. Migrated: `clients/lsp/session-roots.ts` (`registerSessionRoot`), `index.ts` (`ensureLSPConfigInitialized`), `clients/lsp-mutation.ts` (`bookkeepLspMutation`'s per-batch autofix dedupe), and `clients/observed-mutation.ts` (`noteMutationHandled`'s `handled` set) — all FIFO, matching each site's prior semantics, so no runtime behavior changes.
