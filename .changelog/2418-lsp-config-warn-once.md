---
section: Changed
---

- **A broken LSP config now warns once per problem, not once per load attempt (refs #2418)** — a malformed `lsp.json` used to produce a fresh warning on EVERY config load, with no latch at all. It is now deduplicated on the file and the reason instead, alongside the other two config loaders, so a file that starts failing for a NEW reason is reported again rather than being repeated on every load. The ignore is also recorded once per session in the degradation ledger under `config-ignored`, including in every session after the first, which previously recorded nothing.
