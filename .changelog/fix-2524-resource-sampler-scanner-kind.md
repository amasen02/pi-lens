---
section: Fixed
---

- **Resource-sampler scanner timeouts are recorded under their own kind, not the orphan backstop's (closes #2524)** —
  `terminateScannerChild` (`clients/instance-reaper.ts`) hardcoded
  `kind: "orphan-backstop-scanner-escalated"` and a bare `"scan exceeded its
  timeout"` reason, but has two callers with very different budgets and
  cadences: the registry-independent orphan backstop (one scan per cooldown
  window, `BACKSTOP_SCAN_TIMEOUT_MS` 5000ms) and `resource-sampler.ts`'s
  process-table queries (`RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` 2000ms, fired on
  every heartbeat/spawn-bracket tick). Every sampler-path escalation was
  therefore recorded under the backstop's kind — 8 rows observed live in one
  session while `orphan-backstop.json`'s `lastSweepAt` proved the backstop had
  not run (defect shape: a record's subject must be its producer). Fix:
  `terminateScannerChild` now takes its `kind` and `timeoutMs` from an options
  arg the caller supplies (no duplicated kill/verify machinery); the sampler's
  two call sites now record the new `resource-sampler-scanner-escalated` kind
  with its real 2000ms budget in the reason text, while the orphan backstop
  keeps its own kind and 5000ms budget.
  New kind `resource-sampler-scanner-escalated` is classified informational
  (no `⚠` in `/lens-perf`'s degradation summary), not a warning like the
  backstop's: `terminateScannerChild` fires the instant its caller's timer
  elapses, strictly before `spawnCollectStdoutResult` (`clients/child-unref.ts`)
  knows whether "close" or the timeout handler's own settle will win that
  race — so it can and does fire on a query that goes on to settle
  `status: "ok"`, matching the issue's observation of 8 escalations with no
  `resource-sampler-query-failed` row alongside them. That absence is a
  reliable "settled ok, not raced" signal only up to the FIRST genuine query
  failure per subject: `recordQueryFailure` records through
  `recordDegradationOnce`, which is once-per-kind-per-subject for the whole
  session, so a second-and-later genuine timeout for the same subject adds no
  further `resource-sampler-query-failed` row either — at that point the
  discriminator can no longer tell "raced" from "actually failed again" from
  the summary counts alone; the per-event NDJSON latency log and each
  escalation's own `latestReasons` entry remain the durable record. The
  informational rendering itself also drops the reason text (`renderDegradationLines`
  shows only the kind and count for informational kinds), so a forensic read
  needing the "which race" detail must go to `getDegradationSummary()`'s
  `latestReasons` or the NDJSON log, not the rendered summary line.
  Regression test (`tests/clients/resource-sampler-scanner-attribution.test.ts`)
  drives the REAL production path — `sampleProcesses`'s Windows/guarded-CIM
  branch through a real `RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` timeout into the
  real, unmocked `terminateScannerChild` — and asserts the sampler's kind is
  recorded (with its 2000ms budget) while the backstop's kind is not, plus
  the informational (no `⚠`) rendering; a third case pins the sampler's OTHER
  call site (`findDescendantPidsWindows`, reached via
  `sampleProcessTreeCpuPercent`), which the first two cases left untested
  (round 2 review). Only `node:child_process`'s `spawn` and `process.kill`
  are mocked; no real OS process is touched.
  Round 2 review also found the registry-driven reaper's OWN two scanner
  queries — `queryCommandLines` and `findPidsByMarkerWindows`
  (`clients/instance-reaper.ts`, both reached from `sweepOrphans`) — omitted
  `onTimeout` entirely, so a scanner either spawned that blew
  `BACKSTOP_SCAN_TIMEOUT_MS` fell through to `child-unref.ts`'s default
  handler: one bare, unverified `child.kill()`, no tree kill, no
  identity-carrying record — the exact abandonment `terminateScannerChild`
  exists to prevent, reachable from inside the orphan backstop path itself.
  Both now route through `terminateScannerChild` with the backstop's kind and
  budget, matching `enumerateManagedProcesses`'s existing wiring. New test
  `tests/clients/instance-reaper-registry-scan-escalation.test.ts` drives
  `sweepOrphans()` through both real timeouts.
