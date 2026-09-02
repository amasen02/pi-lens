---
section: Fixed
---

- **`recordEntitySnapshotDiff` enforces its absolute-`filePath` invariant (closes #2477)** — the review-graph entity-snapshot / `changedSymbols` facts are keyed by absolute path, and the only production writer (`clients/dispatch/runners/tree-sitter.ts`) always supplies one, so two project roots sharing a relative spelling like `src/index.ts` never collide. A non-absolute `filePath` from a future caller regression is now rejected with a visible, bounded `review-graph-non-absolute-entity-path` degradation record and the diff is skipped, instead of silently mis-keying. No behavior change for the real, always-absolute production path.
