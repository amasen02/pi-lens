---
section: Fixed
---

- **Classify oxlint no-match results as expected skips (closes #1998)**. Oxlint now carries `no-files-matched` through runner telemetry without emitting an extension error or claiming the file is clean. A single fail-closed state machine validates process completion, exit status, stderr, the captured banner, and every JSON summary field's type and range; truncated, malformed, wrong-status, or error-bearing lookalikes retain failure or unconfirmed telemetry.
