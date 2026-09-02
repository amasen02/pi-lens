---
section: Added
---

- **`pilens_effective_config` / `effective_config` answer "why is X running" (closes #2427)** — one query returns the resolved pi-lens configuration with the provenance of every setting (source tier, file, key, trust decision), and for a file you name, its canonical language plus every LSP server with the reason it was selected or denied and every runner that would dispatch. `pilens_health` embeds the same provenance as per-tier counts. Redaction is structural rather than a mode: config paths are `~`-relative, a custom server's command line is cut to the binary itself, environment variables appear as names only, and there is no un-redacted view to ask for. This also closes a live gap in deny precedence — `lsp.disabledServers` now resolves as the union of every tier's entries, so a repository's `.pi-lens.json` can no longer re-enable a language server you disabled in `~/.pi-lens/config.json`, and the answer names the tier that first denied it.
