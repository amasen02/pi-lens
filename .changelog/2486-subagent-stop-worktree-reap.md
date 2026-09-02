---
section: Fixed
---

- **SubagentStop worktree reap no longer no-ops silently (closes #2486)** — `--hook subagent-stop --only <tree>` now removes the named tree under the unchanged dirty/unpushed rails, instead of dropping `--only` and printing "worktrees are never removed here"; removal runs whether or not the process listing succeeded, and a listing that failed is reported alongside it rather than swallowing the run. Each hook's sweep budget is derived from the timeout registered in `.claude/settings.json` (25s for SessionStart, 10s for SubagentStop) rather than a flat 2s that left 6 of 12 worktrees `not-evaluated`, the process-listing ceiling rises from 1200ms to 4000ms against a measured 651ms median on Windows, and a new `--scan-timeout-ms` bounds that listing independently of the sweep. Every invocation now writes one `hygiene.run` ledger record — `fired`, or `skipped` with a reason that tells a missing `agent_id` apart from an agent that never had a worktree.
