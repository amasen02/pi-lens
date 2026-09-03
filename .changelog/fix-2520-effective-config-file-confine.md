---
section: Changed
---

- **`effective_config`/`pilens_effective_config` reject a `file` outside `cwd` instead of silently answering from a foreign tree (refs #2520)** —
  `clients/effective-config.ts`'s per-file half resolved from the FILE's own
  directory whenever `file` was passed, on the documented assumption that
  this root is always a superset of the workspace's — true only when `file`
  actually lies under `cwd`. A `file` in a sibling tree broke that
  assumption silently: the answer resolved a foreign `.pi-lens.json`,
  labelled it tier `project`, omitted the workspace's own document from
  `documents`, and `view.cwd` still named the workspace — a foreign config
  reported as the workspace's own. `effectiveConfig` now confines `file` to
  `cwd` via the shared `isSameOrWithin` containment comparator (the same one
  the LSP session-root registry gates enrollment with): a `file` that does
  not resolve inside `cwd` returns `file: { error: "file is outside cwd" }`
  instead of a resolved view, and the whole-config half still resolves at
  `cwd` rather than touching the foreign tree at all. A file nested INSIDE
  `cwd` (the common case — `ensureLSPConfigInitialized(path.dirname(filePath))`'s
  own layering) is unaffected.
  `EffectiveConfigView.file` is now `EffectiveFileView | EffectiveFileViewError`;
  a new type guard `isEffectiveFileViewError` distinguishes the two. Both
  `tools/effective-config.ts` (the `effective_config` pi tool) and
  `mcp/server.ts` (`pilens_effective_config`) render the rejection instead of
  crashing on the narrowed type. Also collapsed the internal `FileQuery`
  struct: its `absolute` field duplicated the already-hoisted `absolute`
  local, so the per-file LSP config is now derived inline at the one call
  site that needs it, and the stale "SUPERSET of the workspace's" doc comment
  now states the invariant as CONFINED (enforced), not assumed.
  New tests in `tests/clients/effective-config.test.ts` drive the real
  production path (real files on disk, real `resolvePiLensConfig`) for both
  the rejection and the still-working nested-file case.
