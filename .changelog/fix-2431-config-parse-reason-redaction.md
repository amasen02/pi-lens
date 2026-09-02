---
section: Fixed
---

- **Stop leaking config file contents into diagnostics on a JSON parse error (refs #2431)** — Node's `JSON.parse` embeds a slice of the source text in its own error message, so a malformed `.pi-lens.json`/`lsp.json` that happened to carry a credential next to the syntax error leaked it into the notification, `extension.log`, and the degradation ledger. `clients/config-warn.ts`'s shared warn seam now normalizes a caught parse/read error to its class plus a position (`SyntaxError at line 12 col 8`) instead of the raw message, so nothing from the file's contents ever reaches those sinks.
