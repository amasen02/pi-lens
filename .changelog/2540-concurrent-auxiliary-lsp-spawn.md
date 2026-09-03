---
section: Fixed
---

- **LSP auxiliary server spawn concurrent and off-hook bounded (closes #2540)** — on cold first edit, eligible auxiliary servers spawn concurrently via Promise.all bounded by bounded() using the ambient turn signal, rather than running serially. Pre-dispatch sync retains primary-only scope while auxiliary readiness is pushed to the latency log under the auxiliary_readiness phase.
