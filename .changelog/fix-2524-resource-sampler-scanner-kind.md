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
  `status: "ok"` (matching the issue's observation: no
  `resource-sampler-query-failed` row alongside any of the 8 escalations). The
  sampler already treats a lost tick as ordinary best-effort data loss that
  self-heals on the next heartbeat, so this kind is frequent-by-design noise
  rather than an actionable fault.
  Regression test (`tests/clients/resource-sampler-scanner-attribution.test.ts`)
  drives the REAL production path — `sampleProcesses`'s Windows/guarded-CIM
  branch through a real `RESOURCE_SAMPLE_QUERY_TIMEOUT_MS` timeout into the
  real, unmocked `terminateScannerChild` — and asserts the sampler's kind is
  recorded (with its 2000ms budget) while the backstop's kind is not, plus
  the informational (no `⚠`) rendering. Only `node:child_process`'s `spawn`
  and `process.kill` are mocked; no real OS process is touched.
