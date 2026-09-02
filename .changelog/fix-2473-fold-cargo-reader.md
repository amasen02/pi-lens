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
  golden fixture (`tests/fixtures/cargo-modules-snapshot.json`). On this
  fold's own fixture set the diff against the pre-fix baseline was exactly
  the two misread-name rows; review round 2 added adversarial fixtures that
  surfaced two FURTHER pre-existing defects also visible in that same golden
  diff against `master` — see below, and do not read "exactly the two rows"
  as a claim about the final committed golden, which changed four rows in
  total.

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
  leaking the sub-table's own keys in as bogus dependency names — the SAME
  `[ \t]*` anchor fix also makes a CRLF manifest read correctly, since
  ECMAScript's multiline `$`/`^` already treat a bare `\r` as a line
  terminator on its own; the fold additionally runs every manifest through a
  CRLF→LF normalize before any regex runs, kept as defensive
  belt-and-braces, not because the anchor fix leaves a real CRLF match
  failure (review round 3 correction — verified by mutation: removing the
  CRLF→LF pass leaves every test green); (3) `detectWorkspaceType` still did
  a bare `content.includes("[workspace]")`, true for a commented-out
  `# [workspace]` heading — a Cargo.toml with only a commented `[workspace]`
  sitting next to a REAL npm/pnpm workspace was misclassified as an (empty)
  cargo workspace, resolving to `null` instead of the real workspace; (4)
  `readCargoWorkspaceMembers` read `members` unscoped, and
  `clients/lsp/server.ts` hand-composed its own
  `extractTomlTableSection`/`parseTomlStringArray` pair for `members`/
  `exclude` instead of reusing it — both readers now go through
  `[workspace]`-scoped `readCargoWorkspaceMembers`/`readCargoWorkspaceExclude`.
  Regenerating the golden against this round's fixtures also surfaced a
  THIRD pre-existing defect in master's OLD (pre-#2473) reader, not
  introduced by the fold: `extractTomlSection` required an EXACT trimmed
  `"[dependencies]"` line match, so a trailing comment on the table heading
  (`[dependencies] # direct deps`) made it silently return zero dependencies
  — fixed for free by the table-scoped, comment-tolerant heading regex; this
  is one of the two rows noted above as changing beyond the original two
  misread-name rows (the other being `detectWorkspaceType`'s
  commented-heading fix, (3) above). All fixes are pinned by new adversarial
  fixtures under `tests/fixtures/cargo-workspace-modules/adv-*` (commented
  member, indented `[package]`, indented sub-table, CRLF, a trailing comment
  on a table heading, and a commented-out `[workspace]` heading next to a
  real npm workspace), direct unit tests in `tests/clients/cargo-manifest.
  test.ts`, and regression tests on the `clients/lsp/server.ts` consumer in
  `tests/clients/lsp/server-policy.test.ts`.

  Review round 3 fixed a second sentinel-ambiguity defect: `extractTomlTableSection`
  returned `""` for BOTH "table absent" and "table present but empty" (e.g. a
  bare `[workspace]` heading as the last line of the file with no trailing
  newline, or `[workspace] # root`/`[workspace]   ` at EOF) — three call
  sites relied on a `!== ""` sentinel to mean "table present": review round
  2's `detectWorkspaceType` fix above (misclassified a root crate's own
  Cargo.toml as an npm workspace) and both of `resolveCargoPackageEdition`'s
  "is this manifest also the workspace root" checks, which predate #2473
  entirely (#2466 — silently fell back to no `--edition` instead of
  resolving the inherited value). `extractTomlTableSection` now returns
  `string | undefined` (`undefined` for absent, `""` for present-but-empty)
  and all three call sites compare `!== undefined`.
  `readCargoDependencyNames` also dropped a redundant, non-quote-aware
  `line.split("#", 1)[0]` re-strip — its input is already comment-stripped by
  `normalizeToml`. Pinned by a new adversarial fixture
  (`adv-i-empty-workspace-eof`), a `resolveCargoPackageEdition` regression
  test, and the golden snapshot.
