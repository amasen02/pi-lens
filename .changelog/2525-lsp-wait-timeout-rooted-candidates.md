---
section: Fixed
---

- **LSP wait and sweep-warm-up records name only rooted candidates (closes #2525)** — a plain TypeScript project with no `deno.json` logged `serverIds: ["typescript","deno"]` in `lsp_client_wait_timeout`, `lsp_client_wait_skipped` and the `lsp_sweep_warmup_*` records, even though Deno's fallback server never resolved a root and never spawned. All five records now list only candidates with a resolved root, plus a separate `unrootedCandidates` count/id list. Roots are resolved lazily on the cold record paths and memoized per acquisition, so a warm touch resolves nothing extra and the `lsp_client_unavailable` bookkeeping no longer re-walks a root the acquisition attempt already resolved.
