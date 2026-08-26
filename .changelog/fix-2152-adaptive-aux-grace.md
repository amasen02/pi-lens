---
section: Fixed
---

- **Adapt the first cold auxiliary wait to observed spawn cost (closes #2152)** — a cold auxiliary touch uses the larger of its declared wait and the server's last successful spawn duration plus a 500ms margin, capped at 8s. Warm touches retain the declared wait capped at 2s, and `PI_LENS_AUX_GRACE_MS` caps the budget (it never raises it).
