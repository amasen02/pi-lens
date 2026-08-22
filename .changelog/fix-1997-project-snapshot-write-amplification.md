---
section: Fixed
---

- **Project snapshots no longer rewrite unchanged same-generation bodies (closes #1997)** — Persistence now coalesces concurrent requests and computes semantic identity on its worker before gzip or staging. Same-generation content changes and failed-write repairs still publish.
