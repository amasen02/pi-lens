---
section: Fixed
---

- **Redirect the global pi-lens dir away from the real home when a probe forgets to pin `PI_LENS_HOME` (closes #2506)** —
  an ad-hoc probe against the
  built `clients/*.js` outside vitest (a bare `node -e`, a throwaway `.mjs`, a
  harness script) has no test-mode gate and no home pin, so every
  logger/ledger/cache it touched used to write straight into the real
  `~/.pi-lens`. Confirmed live on 2026-09-02: two review probes left 42 rows
  of fixture garbage in real telemetry — short-lived PROBE processes, not
  vitest (which is already hermetic via `tests/support/vitest-setup.ts`'s
  `PI_LENS_HOME` pin). `getGlobalPiLensDir()` (`clients/file-utils.ts`), the
  one resolver every global writer routes through, now redirects to
  `<cwd>/.pi-lens-probe-home` instead of the real home directory when
  `PI_LENS_HOME` is unset, the process is not in test mode, and `cwd` sits
  under a `.claude/worktrees/` segment or under `os.tmpdir()`; `PILENS_PROBE=1`
  forces the same redirect from an ordinary project checkout. The first
  redirect in a process logs one stderr line and records a bounded
  `global-dir-probe-redirect` degradation. `getProjectDataDir(cwd)`'s default
  branch composes through `getGlobalPiLensDir()`, so it is covered too.
