---
section: Changed
---

- **Persist word-index changes incrementally off the hot path (refs #2068)** — packed posting lanes now reuse cached wire segments for untouched documents, so a per-edit persist rebuilds only dirty document contributions. Dirty files resolve through one wire-slot map, and each affected token lane flattens once per persist while the existing snapshot worker handles stringify and gzip.
