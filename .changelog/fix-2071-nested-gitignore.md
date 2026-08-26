---
section: Fixed
---

- **Nested `.gitignore` edits now refresh ignore verdicts (closes #2071)** —
  agent writes invalidate every cached project matcher containing the edited
  path, so its per-path memo cannot serve a verdict from an older ignore file.
  Root edits rebuild each affected matcher, while nested edits preserve
  compiled-glob reuse for sibling trees.
