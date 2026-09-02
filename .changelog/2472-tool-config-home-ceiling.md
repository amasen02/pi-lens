---
section: Changed
---

- **Local tool-config discovery (opengrep, ast-grep, typos, zizmor) now stops at the user's home directory (refs #2472).**
  `findLocalOpengrepConfig`, `findLocalSgconfig`, `findLocalTyposConfig`, and
  `findLocalZizmorConfig` each walked ancestor directories looking for their
  tool's config file with no ceiling, so a search starting from a project
  nested directly under `$HOME` (or from `$HOME` itself with no enclosing
  project) could climb to `$HOME` or above and pick up an unrelated config
  there — the same #250/#253 defect class every other ancestor-project-root
  walker in the codebase already guards against. These four now stop at the
  home-directory ceiling by default, matching `resolvePhpCsFixerConfig`'s
  existing guard; a config that previously resolved from at-or-above `$HOME`
  is no longer found.
