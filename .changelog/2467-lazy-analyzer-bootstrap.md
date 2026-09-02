---
section: Changed
---

- **Analyzer bootstrap clients load on demand, not at session start (closes #2467)** — the seventeen shell-out analysis clients are no longer built before `handleSessionStart` runs; extension activation and quick-mode session start now complete without loading the graph at all, and the load is paid by the first consumer that proves it needs it. All demands share one retryable in-flight promise, a transient failure is retried by the next demand and fails open for the caller (counted under the new `analyzer-bootstrap-unavailable` degradation kind), the wait is bounded by both a wall-clock ceiling and the caller's abort signal, and primary `session_shutdown` refuses new loads without invalidating a demand already in flight. An irrelevant `tool_call` — a bash command, a vendored file, a file already baselined — no longer loads or awaits the graph.
