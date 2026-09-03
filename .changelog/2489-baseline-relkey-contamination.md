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
  which can never collide across projects.
