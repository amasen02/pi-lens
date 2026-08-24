---
section: Fixed
---

- **Gate nested LSP requests (closes #1971)** — Skip `workspace/willRenameFiles` and `codeAction/resolve` when servers do not advertise those capabilities, while preserving supported edits and unresolved-action fallbacks.
