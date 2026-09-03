---
section: Fixed
---

- **`lsp_client_wait_timeout`/`lsp_client_wait_skipped` name only rooted wait candidates (closes #2525)** — a plain TypeScript project with no `deno.json` logged `serverIds: ["typescript","deno"]` even though Deno's fallback server never resolved a root and never spawned. Both records now list only candidates with a resolved root, plus a separate `unrootedCandidates` count/id list, and the wait loop no longer re-resolves an unrooted fallback's root on every touch that takes the known-slow shortcut.
