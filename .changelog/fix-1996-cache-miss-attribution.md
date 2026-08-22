---
section: Fixed
---

- **Cache-miss attribution stays useful in long sessions (closes #1996)** — classify model/provider switches and split unexplained cache misses by bounded evidence reason, with fail-closed heuristic attribution and a per-session cause summary that preserves request-time and primary/secondary isolation.
