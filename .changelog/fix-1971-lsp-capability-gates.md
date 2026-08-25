---
section: Fixed
---

- **Gate nested LSP requests (closes #1971)** — Skip `workspace/willRenameFiles`, `workspace/didRenameFiles`, and `codeAction/resolve` unless the server registered them, matching each registration's scheme/glob/file-kind filters at the send boundary while preserving supported edits and unresolved-action fallbacks.
