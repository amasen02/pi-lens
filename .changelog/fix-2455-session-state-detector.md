---
section: Fixed
---

- **Session-state sweep detector no longer hard-codes container class names (refs #2442, #2455)** — `tests/support/session-state-scan.ts` recognised module-level state only when bound to `new (Map|Set|WeakMap|WeakSet|PathKeyedMap|BoundedFifoMap|BoundedLruCache)`. Migrating `cache-observability.ts`'s maps to `BoundedFifoMap` (#2442) had already proven the failure mode once — a file drops out of the sweep silently until the new wrapper's name is added to the alternation by hand. The detector now scans `clients/` once per run for every exported class that owns a `clear()`/`delete()` method (resolved directly or through an `extends` chain) and recognises `new <that class>(...)` the same way it recognises `new Map(...)`; a class that structurally qualifies but provably holds no session state gets a documented `CONTAINER_CLASS_EXCLUSIONS` entry instead of a special case at the call site (empty today).

  Re-pinned two `SESSION_STATE_SYMBOL_COUNTS` rows the wider detection now sees: `dispatch/integration.ts` 8 → 9 (`sessionRunnerRegistry`, an import-time-built `RunnerRegistry` with no session lifetime) and `widget-state.ts` 3 → 5 (`diagnosticsWriteGuard`/`runnerWriteGuard`, both `WriteOrderingGuard` instances already cleared by the existing `clearWidgetState` reset — only the pin was stale, not the wiring).
