---
section: Fixed
---

- **Deflaked three shared-slot-contention test races (closes #2512, closes #2495)** —
  `tests/index-vanished-instance-wiring.test.ts` no longer bridges the
  fire-and-forget registerInstance/logVanishedInstances/sweepOrphans registry
  chain with a fixed 50ms sleep; it now wraps `sweepOrphans` (the chain's last
  step) to notify an awaitable settle signal, so the test proves the whole
  chain has landed instead of guessing a wall-clock window.
  `tests/clients/runtime-turn-session.test.ts`'s real-child-spawn test now
  carries an explicit 20s timeout and is phased into vitest's fully
  serialized, dead-last `wall-clock-budget` project, removing the contention
  that made it exceed vitest's 5000ms default under a busy batch.
  `tests/clients/topology-derived-cache-rearm.test.ts` no longer asserts an
  exact null `projectRoot` for a synthetic `homeDir` that only pins the
  ceiling check and cannot confine `findNearestProjectRoot`'s contractually
  unbounded upward walk — a real project marker anywhere above the test's
  temp directory on the host (matching `tests/clients/
  startup-scan-home-ceiling.test.ts`'s established fixture shape) previously
  produced a found-but-rejected root instead of `null`. The assertion now
  checks `canWarmCaches`, which is deterministic regardless of the host's
  real ancestor tree.
