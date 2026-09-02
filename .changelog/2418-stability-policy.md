---
section: Deprecated
---

- **Deprecation windows for the legacy LSP config surfaces (refs #2418)** — the stability policy in `docs/public-api-stability.md` now records, as test-checked data, which config surfaces are deprecated and when they may be removed. Deprecated since 4.1.3, removable no earlier than 5.0.0, and read unchanged until then: the config keys `servers`, `serverOverrides`, `disabledServers`, and `warmFiles`; and the config file locations `.pi-lens/lsp.json`, `pi-lsp.json`, `pi-lens.json`, `~/.pi-lens/lsp.json`, plus the legacy top-level LSP keys read from `.pi-lens.json` (the file itself stays canonical). Config warnings now end in a stable code — `[PILENS_CFG_0001]` for an unreadable or unparsable config file — so they can be matched or suppressed without depending on the message prose. No behavior changes in this release.
