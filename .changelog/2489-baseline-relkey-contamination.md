---
section: Fixed
---

- **Stop cross-project delta-baseline contamination on the warm MCP server (closes #2489)** —
  `dispatcher.ts`'s delta-mode baseline read fell back from an absolute-path
  key to a cwd-blind relative-path key. On the warm `pilens_analyze` route's
  module-scope `FactStore`, which can serve many project roots over one
  process lifetime, two projects dispatching files that share a relative
  path (e.g. both have `src/index.ts`) could collide on that fallback key,
  so a project's first-ever delta baseline read could silently return a
  different project's stored diagnostics. The relative fallback is removed;
  the baseline is now keyed on the absolute, normalized file path only,
  which can never collide across projects. The absolute-path invariant is
  now enforced at this seam too (a hand-built, non-absolute `filePath`
  skips the baseline read/write with a visible degradation record, mirroring
  the review-graph entity-snapshot guard from #2477), and the delta
  baseline hit/miss and warning count are now surfaced on the
  `dispatch_complete` latency record.
