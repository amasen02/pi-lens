---
section: Fixed
---

- **Send a stray probe's LOGS to a scratch dir instead of the real `~/.pi-lens`, without moving its tools or registry (closes #2506)** —
  an ad-hoc probe against the built `clients/*.js` outside vitest (a bare
  `node -e`, a throwaway `.mjs`, a harness script) has no test-mode gate and no
  `PI_LENS_HOME` pin, so every logger and ledger it touched used to write
  straight into the real `~/.pi-lens`. Confirmed live on 2026-09-02: two review
  probes left 42 rows of fixture garbage in real telemetry — short-lived probe
  processes, not vitest (already hermetic via `tests/support/vitest-setup.ts`'s
  `PI_LENS_HOME` pin). The global-directory resolver in `clients/file-utils.ts`
  is now split in two. `getGlobalPiLensDir()` stays cwd-independent and keeps
  resolving machine-global state — installed tools, `bin/`, the cross-process
  `instances.json` and its orphan-backstop lease, the auto-install probe cache,
  the global `config.json`, LSP server storage, JVM runtimes — so a pi session
  running from an agent worktree or a temp project still finds the tools it
  installed and stays visible to every other pi-lens process on the machine. A
  new `getGlobalPiLensLogDir()` carries the redirect and is used by the log
  family only (`latency`, `extension`, `sessionstart`, `cascade`, `read-guard`,
  `tree-sitter`, `word-index`, `bus-events`, `dispositions`, `dead-code`,
  `ast-grep-tools`, `actionable-warnings`, `review-graph`, the `logs/*.jsonl`
  diagnostic dir, the debug handle/heap dumps, log cleanup and the smells
  rollup's read-side tail). It redirects to `<probe root>/.pi-lens-probe-home`
  when `PI_LENS_HOME` is unset and either `PILENS_PROBE=1` is set or — outside
  test mode — the cwd sits inside a specific `.claude/worktrees/<worktree>/` or
  under `os.tmpdir()`. The redirect resolves once per process and records a
  bounded `global-dir-probe-redirect` degradation; `.pi-lens-probe-home/` is
  gitignored so a worktree that ran a probe does not stay dirty forever.
