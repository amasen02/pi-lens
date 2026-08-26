---
section: Fixed
---

- **Share one LSP service across module evaluations (refs #2157)** — all evaluations now share one service, its generation handoff, workspace-sweep hold, and classic TypeScript repair guard through versioned process-singleton families. Incompatible live services shut down fast before replacement, and a secondary pipeline crash or a secondary session's idle-reset timer no longer tears down the primary fleet.
