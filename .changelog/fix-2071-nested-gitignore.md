### Fixed

- **Nested `.gitignore` edits now refresh ignore verdicts (closes #2071)** —
  agent writes invalidate the affected matcher subtree, so its per-path memo
  cannot serve a verdict from an older ignore file. Root edits rebuild the
  matcher, while nested edits preserve compiled-glob reuse for sibling trees.
