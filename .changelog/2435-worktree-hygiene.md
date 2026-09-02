---
section: Added
---

- **Agent worktree and orphan-process hygiene (closes #2435)** — New
  `npm run hygiene` (`scripts/prune-agent-worktrees.mjs`) removes finished
  `.claude/worktrees/agent-*` checkouts that are clean, pushed and idle for at
  least 30 minutes, and reaps `tests/fixtures/*` helper processes whose parent
  has exited. Idleness is measured from signals the sweep's own inspection
  does not write — the checkout directory, the worktree's `HEAD`, and the HEAD
  reflog's last entry — never from the git index, which `git status` rewrites.
  It never removes a dirty or unpushed tree, never kills a fixture process
  whose parent is still alive or whose parent pid is unreadable, never kills a
  process that merely names a worktree on its command line, and records every
  kill, removal and degraded process scan as bounded JSONL in
  `~/.pi-lens/hygiene.log`. It runs automatically from the `SessionStart` hook
  on `startup` and `resume` only (never on `/clear`, compaction or a fork), and
  removes at most one tree per run; the `SubagentStop` hook only reaps that
  agent's orphaned test helpers and never removes a worktree. Targeted test
  runs gain `npm run test:targeted`, a shared-slot mode of the machine-wide
  test lock that caps concurrent targeted `vitest` batches (default 2) while
  full-suite runs still take the box exclusively; it requires at least one test
  path.
