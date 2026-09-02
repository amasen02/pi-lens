---
section: Fixed
---

- **Monorepo module-graph crate names are now read from `[package]` only (closes #2473)** — `clients/review-graph/workspace-modules.ts`'s Cargo.toml
  reader for the cascade module graph scanned the WHOLE manifest for the
  first `name = "..."` line, regardless of which TOML table it fell under. A
  member crate whose `name` key appeared under a table other than
  `[package]` earlier in the file — a `[[bin]] name = "..."` entry or a
  `[package.metadata.*]` block preceding `[package]` — was misread as that
  crate's name, silently mislabeling it in the module graph and cascade
  downstream analysis. The reader is folded onto `clients/cargo-manifest.ts`
  (#2466)'s shared, table-scoped parser (`readCargoPackageName`/
  `readCargoWorkspaceMembers`/`readCargoDependencyNames`), fixing the
  `[package] name` lookup to read only the `[package]` table. Workspace
  `members` array and `[dependencies]` name extraction are unchanged
  (already table-scoped or with no realistic table collision) — pinned by a
  golden fixture (`tests/fixtures/cargo-modules-snapshot.json`) whose diff
  against the pre-fix baseline is exactly the two misread-name rows.
