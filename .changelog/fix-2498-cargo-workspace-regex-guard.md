---
section: Fixed
---

- **Rust workspace-root hoisting reads `[workspace]` presence through the shared Cargo.toml reader, not a second hand-rolled regex (closes #2498)** —
  `clients/lsp/server.ts`'s `RustWorkspaceRoot` walk-up carried
  `/^\s*\[workspace\]/m.test(parentCargoContent)` four lines above
  `cargoWorkspaceDeclaresMember`, which #2480 had already converted to
  `clients/cargo-manifest.ts`'s shared, table-scoped readers — a second regex
  TOML reader outside the one file AGENTS.md names as the single source of
  truth for Cargo.toml parsing. Behaviorally identical to
  `extractTomlTableSection(content, "workspace") !== undefined` under every
  probed shape (comments, indentation, CRLF, trailing content on the
  heading), so no runtime behavior changes. New export
  `hasCargoWorkspaceTable(content)` in `clients/cargo-manifest.ts` names the
  presence check; `clients/lsp/server.ts` and both of
  `resolveCargoPackageEdition`'s own "is this manifest also the workspace
  root" checks now call it instead of repeating the `!== undefined` idiom.
  A new sweep (`tests/clients/cargo-manifest.test.ts`) fails the build if a
  future edit reintroduces a hand-rolled `\[workspace\]` regex anywhere in
  `clients/` outside `cargo-manifest.ts` — proven to actually fire via a
  mutation check against the exact pre-fix defect shape before trusting it
  against the real tree.
