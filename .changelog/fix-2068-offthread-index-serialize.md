---
section: Fixed
---

- **Move word-index snapshot serialization off the main thread (refs #2068)** — Per-edit persistence now structured-clones the live index and derives its wire snapshot in the existing snapshot worker.
