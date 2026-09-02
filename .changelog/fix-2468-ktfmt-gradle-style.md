---
section: Fixed
---

- **ktfmt now carries the project's Gradle `ktfmt { }` style selection (closes #2468)** — ktfmt was invoked bare (`ktfmt <file>`), so it formatted
  under its own default style instead of the project's actual
  `googleStyle()`/`kotlinLangStyle()` selection in `build.gradle(.kts)`'s
  `ktfmt { }` extension block. The declared style is now resolved and passed
  through `--google-style`/`--kotlinlang-style`, scoped the way Gradle scopes
  the block that declares it: a `subprojects { }` style reaches the modules
  and not the root project's own sources, `allprojects { }` and a top-level
  block reach both, and the search continues up the ancestors when the
  module's own build file declares no style — the multi-module layout where
  the root build file holds the style and each module declares only its
  plugins. A nearer declaration still wins over an ancestor's, and a body
  calling both style functions resolves to the last call, as Gradle does. An
  unreadable/unparseable build file, no declared style, or the ktfmt-gradle
  plugin's removed `dropboxStyle()` falls back to the previous bare
  invocation unchanged.
