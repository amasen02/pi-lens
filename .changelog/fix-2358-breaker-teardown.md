---
section: Fixed
---

- **Breaker teardown tells dead from busy (#2358).** The LSP notify-stall breaker
  grants a wedged scanner an adaptive patience window (per-write drain latency
  x backlog depth) and samples its process CPU before any kill. A server that
  is burning a core while it drains a burst is left alone and re-armed, not
  torn down; only a flat-CPU or cap-exceeded server is killed, and the teardown
  record names which discriminator fired. Windows CPU sampling now resolves
  `powershell.exe` through `System32`, which was silently missing before.
