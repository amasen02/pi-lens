---
section: Fixed
---

- **A nested `executeCommand` no longer strips the outer LSP call's mutation receipt (closes #2479)** — `runServerCommand` restored `activeMutationContext` only once its depth counter returned to 0, so a nested `workspace/executeCommand` unwinding back to depth 1 left the outer call without its own context for the rest of its window: every server-initiated `workspace/applyEdit` the outer call solicited after that point fell to the mutation-bridge fallback and was recorded as a generic `agent-tool:lsp-workspace-applyEdit` write rather than the operation that actually asked for it (`lsp-rename` / `lsp-execute-command`). The context slot is now a per-frame save/restore stack, still cleared outright at depth 0 so "no command in flight" continues to mean "no context". The executeCommand hardening invariants are unchanged.
