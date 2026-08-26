---
section: Fixed
---

- **Prove idle-eviction replacements release graph memory (closes #2073)** — Add an enforced forced-GC test for twenty 2,000-node workspace graph replacements. The cache retains under 6 MiB after replacement, proving outgoing eviction timers do not retain prior graphs.
