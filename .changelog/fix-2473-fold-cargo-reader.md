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

  Review round 2 hardened the fold itself, which had regressed four cases the
  pre-fold, per-line reader handled correctly: (1) `parseTomlStringArray`
  harvested a quoted string from a COMMENTED-OUT array entry (`# "member",`)
  because its single multi-line regex scan never stripped comments — a
  commented-out workspace member whose crate directory still exists on disk
  wrongly entered the module graph, and `clients/lsp/server.ts`'s rust-analyzer
  `exclude`/`members` reads shared the same bug; (2) `extractTomlTableSection`
  anchored its heading and terminator regexes at column 0, so a validly
  INDENTED `[package]` heading was never read (crate silently dropped — a
  single-member workspace resolved to `null`) and an indented sub-table
  heading (`  [dependencies.tokio]`) never terminated the parent table,
  leaking the sub-table's own keys in as bogus dependency names; a CRLF
  manifest hit the same anchor bug via the stray `\r`; (3)
  `detectWorkspaceType` still did a bare `content.includes("[workspace]")`,
  true for a commented-out `# [workspace]` heading — a Cargo.toml with only a
  commented `[workspace]` sitting next to a REAL npm/pnpm workspace was
  misclassified as an (empty) cargo workspace, resolving to `null` instead of
  the real workspace; (4) `readCargoWorkspaceMembers` read `members`
  unscoped, and `clients/lsp/server.ts` hand-composed its own
  `extractTomlTableSection`/`parseTomlStringArray` pair for `members`/
  `exclude` instead of reusing it — both readers now go through
  `[workspace]`-scoped `readCargoWorkspaceMembers`/`readCargoWorkspaceExclude`.
  All four fixes are pinned by new adversarial fixtures under
  `tests/fixtures/cargo-workspace-modules/adv-*` (commented member, indented
  `[package]`, indented sub-table, CRLF, a trailing comment on a table
  heading, and a commented-out `[workspace]` heading next to a real npm
  workspace), direct unit tests in `tests/clients/cargo-manifest.test.ts`, and
  regression tests on the `clients/lsp/server.ts` consumer in
  `tests/clients/lsp/server-policy.test.ts`.
