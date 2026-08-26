---
section: Fixed
---

- **Stop duplicate merge-train warden actions (closes #2150)** — the warden stops on a non-advancing GraphQL cursor and deduplicates PR records before applying actions.
