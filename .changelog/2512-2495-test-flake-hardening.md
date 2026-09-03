---
section: Fixed
---

- **Deflaked four shared-slot-contention test races (closes #2512, closes #2495)** —
  `tests/index-vanished-instance-wiring.test.ts` no longer bridges the
  fire-and-forget registerInstance/logVanishedInstances/sweepOrphans registry
  chain with a fixed 50ms sleep; it now wraps `sweepOrphans` (the chain's last
  step) to notify an awaitable settle signal, so the test proves the whole
  chain has landed instead of guessing a wall-clock window.
  `tests/clients/runtime-turn-session.test.ts`'s real-child-spawn test now
  carries an explicit 20s timeout (4x the observed worst case), absorbing
  the same shared-slot contention directly instead of exceeding vitest's
  5000ms default under a busy batch; it stays in the default parallel
  project since it asserts no elapsed-time budget, so it does not qualify
  for the wall-clock-budget project's dead-last serialized phase.
  `tests/clients/topology-derived-cache-rearm.test.ts` no longer asserts an
  exact null `projectRoot` for a synthetic `homeDir` that only pins the
  ceiling check and cannot confine `findNearestProjectRoot`'s contractually
  unbounded upward walk — a real project marker anywhere above the test's
  temp directory on the host (matching `tests/clients/
  startup-scan-home-ceiling.test.ts`'s established fixture shape) previously
  produced a found-but-rejected root instead of `null`. The assertions now
  check `projectRoot` identity against the tmp cwd directly, which is
  deterministic regardless of the host's real ancestor tree (checking
  `canWarmCaches` instead was itself vacuous, since the synthetic `homeDir`
  rejects every reachable root before and after a marker is planted).
  `tests/clients/dispatch/runners/runner-helpers.test.ts`'s locale-key dedup
  test now asserts the probe call count only after both racing callers have
  settled, instead of right after a fixed 100ms sleep — the sleep itself
  stays (it lets the second caller join the in-flight probe before it
  resolves), but the assertion moved off that timing-dependent instant.
