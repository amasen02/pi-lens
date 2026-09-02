---
section: Fixed
---

- **Stop asserting build-attempt identity on wall-clock milliseconds (refs #2441)** — `ProjectReport.lastBuildAttempt` now carries the review graph's existing process-wide monotonic `buildId`, and three flaky assertions across `build-latch.test.ts`, `review-graph-seq-fastpath.test.ts`, and `review-graph.service.test.ts` compare `buildId`/`buildGeneration` instead of a `new Date().toISOString()` field that two attempts can legitimately share when they land in the same millisecond (the `build-latch.test.ts:299` CI flake). No production behavior changes — the monotonic identity already existed internally; it's now part of the public `ProjectReport` type and the tests key on it.
