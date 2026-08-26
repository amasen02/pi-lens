---
section: Fixed
---

- **Scope availability probe flights per owner (refs #2131, refs #2140)** — Package-manager, dispatch, toolchain, checker, cwd, and security-scan availability owners now hold separate keyed flights, so an owner reset cannot tear down another owner’s probe. Release-managed binaries under `~/.pi-lens/bin` answer before PATH probing, and the resolved path reaches security scans.
