---
section: Changed
---

- **A globally disabled language server can no longer be re-enabled by a repository (refs #2427)** — `lsp.disabledServers` is now resolved as the UNION of every configuration tier instead of nearest-file-wins, and the union spans both spellings of the key, so a `~/.pi-lens/config.json` that disables `typos` keeps it disabled even when a checked-in `.pi-lens.json` says `lsp.disabledServers: []`, and even when the two files spell the setting differently (the deprecated root `disabledServers` vs. the canonical `lsp.disabledServers`). There is no vocabulary for un-denying an entry, so a nearer file that omits one is expressing nothing rather than an allow. If you relied on a repository config clearing your global disable list, remove the entry from the global file instead. `pilens_effective_config` reports which tier denied each server.
