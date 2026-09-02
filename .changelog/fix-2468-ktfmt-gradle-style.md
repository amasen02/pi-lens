---
section: Fixed
---

- **ktfmt now carries the project's Gradle `ktfmt { }` style selection (closes #2468)** — ktfmt was invoked bare (`ktfmt <file>`), so it formatted
  under its own default style instead of the project's actual
  `googleStyle()`/`kotlinLangStyle()` selection in `build.gradle(.kts)`'s
  `ktfmt { }` extension block. The nearest module's declared style is now
  resolved and passed through `--google-style`/`--kotlinlang-style`; an
  unreadable/unparseable manifest, no declared style, or the ktfmt-gradle
  plugin's removed `dropboxStyle()` falls back to the previous bare
  invocation unchanged.
