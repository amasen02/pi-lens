---
section: Fixed
---

- **Bound markdownlint verification and preserve typed spawn failures (closes #2045)** — markdownlint-cli2 now verifies through its stdin mode without scanning project files, and verifier logs retain the effective check command and typed timeout or spawn failure kind.
