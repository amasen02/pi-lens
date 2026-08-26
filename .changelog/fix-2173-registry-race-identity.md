---
section: Fixed
---

- **Preserve identity during concurrent instance registration (refs #2173)** — An adjacent O_EXCL lock serializes registry writers, reclaims stale ownership, and preserves session identity during child-first synthesis.
