---
section: Fixed
---

- **Bound the Vue language-server verification probe (refs #2176)** — the managed Vue registry entry now gives its cold-start `--version` probe a 30-second per-tool ceiling, while all other tools retain the 10-second installer default.
