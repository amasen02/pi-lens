---
section: Fixed
---

- **`mcp/analyze.ts`'s warm review-graph entity-snapshot diff no longer collides across project roots (closes #2477)** — `recordEntitySnapshotDiff` and the builder's `changedSymbols` read now key the per-file entity snapshot by `(cwd, path)`, not path alone. A long-lived warm MCP process serving `analyze` calls for two different project roots that happen to share a relative path (e.g. both have `src/index.ts`) previously diffed the second project's file against the first project's stored snapshot, misreporting `added`/`removed`/`modified` symbols. `clients/path-utils.ts` gains `combineCwdScopedKey`, a small shared primitive both the writer and the reader fold their key through.
