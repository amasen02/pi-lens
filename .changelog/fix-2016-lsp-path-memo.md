---
section: Fixed
---

- **Memoize repeated LSP document path normalization (refs #2016)** — Each client reuses canonical document keys across edits and clears all equivalent spellings when a document closes or the client tears down.
