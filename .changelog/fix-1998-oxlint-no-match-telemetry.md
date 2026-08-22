---
section: Fixed
---

- **Classify oxlint no-match results as expected skips (closes #1998)**. Oxlint now carries `no-files-matched` through runner telemetry without emitting an extension error or claiming the file is clean. The skip requires Oxlint's genuine no-files envelope; zero-file JSON carrying errors or stderr retains normal parsed-failure telemetry.
