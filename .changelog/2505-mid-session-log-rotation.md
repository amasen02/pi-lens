---
section: Fixed
---

- **NDJSON log sinks rotate mid-session, not only at session start (closes #2505)** — the shared `createNdjsonLogger` write path now accounts for the size of the write itself (not only what is already on disk) before appending, so a batch that alone crosses `maxBytes` rotates instead of sailing past the bound with nothing left to trigger a follow-up check. The real `fs.statSync` reconciliation is throttled to a bounded cadence (at most every 25 writes or 2s) instead of running on every write. Every mid-session rotation is folded into the degradation ledger (`log-sink-rotated`, `pilens_health`) without the module writing about itself through the sink it just rotated. A long-lived process that never re-runs the session-start cleanup sweep — the warm MCP server included — now bounds `read-guard.log`, `latency.log`, `cascade.log`, `actionable-warnings.log`, and `ast-grep-tools.log` the same way a normal session does.
