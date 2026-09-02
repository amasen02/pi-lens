---
section: Added
---

- **Agent worktree and orphan-process hygiene (closes #2435)** — New
  `npm run hygiene` (`scripts/prune-agent-worktrees.mjs`) removes finished
  `.claude/worktrees/agent-*` checkouts that are clean, pushed and old, and
  reaps `tests/fixtures/*` helper processes whose parent has exited. It never
  removes a dirty or unpushed tree, never kills a fixture process whose parent
  is still alive, never kills a process that merely names a worktree on its
  command line, and records every kill, removal and degraded process scan as
  bounded JSONL in `~/.pi-lens/hygiene.log`. It runs automatically from the
  `SessionStart` hook (which removes at most one tree per run) and the
  `SubagentStop` hook, which only reaps that agent's orphaned test helpers and
  never removes a worktree. Targeted test runs gain `npm run test:targeted`, a
  shared-slot mode of the machine-wide test lock that caps concurrent targeted
  `vitest` batches (default 2) while full-suite runs still take the box
  exclusively; it requires at least one test path.
