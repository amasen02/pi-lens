---
section: Added
---

- **Agent worktree and orphan-process hygiene (closes #2435)** — New
  `npm run hygiene` (`scripts/prune-agent-worktrees.mjs`) removes finished
  `.claude/worktrees/agent-*` checkouts that are clean, pushed and old, and
  reaps `tests/fixtures/*` helper processes whose parent has exited. It never
  removes a dirty or unpushed tree, never kills a fixture process whose parent
  is still alive, records every kill and removal as bounded JSONL in
  `~/.pi-lens/hygiene.log`, and runs automatically from the `SessionStart` and
  `SubagentStop` hooks in `.claude/settings.json`. Targeted test runs gain
  `npm run test:targeted`, a shared-slot mode of the machine-wide test lock
  that caps concurrent targeted `vitest` batches (default 2) while full-suite
  runs still take the box exclusively.
