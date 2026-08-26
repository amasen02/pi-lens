---
section: Fixed
---

- **Preserve identity during concurrent instance registration (closes #2173)** — Registry recovery keeps the session root, start time, and subagent identity while bounded write verification retries prevent lost registrations.
