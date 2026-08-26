---
section: Fixed
---

- **Bound the stale-findings re-arm loop and count cap-evicted pairs (closes #2167, closes #2168)** — Late-auxiliary turn-end harvesting now caps a pair that keeps returning stale findings at `MAX_LATE_AUX_REARMS` re-arms, re-arms (instead of dropping) a pair after a transient probe-cache read failure, and counts a pending-coverage cap eviction with a dedicated `capEvicted` counter folded into the turn's reconciliation sum.
