---
section: Changed
---

- **Turn-end test runner excludes integration/e2e targets and reconciles its wall budget (closes #2522)** — Selection now filters every resolved test target (failed-first/related/self) through a built-in exclusion list (`**/integration/**`, `**/e2e/**`, `**/*.integration.*`, `**/*.e2e.*`) before it can be auto-fired, logging which targets were skipped and why. The batch-wide wall budget (`TEST_RUNNER_BATCH_BUDGET_MS`) is reconciled from #2509's 90s down to 20s — well under the turn and distinct from the 60s per-target timeout — with excess targets deferred to the next turn via the existing bounded-degradation path. The "Test failures detected last turn — fix before continuing" context message is no longer emitted for a batch made entirely of runner errors (timeouts, missing provider/binary); those are now delivered as advisory.
