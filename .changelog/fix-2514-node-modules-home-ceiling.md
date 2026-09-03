---
section: Fixed
---

- **A formatter installed only at your home directory is no longer used as a project's formatter (closes #2514)** — the ancestor walk that looks for a
  project-local `node_modules/.bin`, `vendor/bin` or `.venv`/`venv` binary
  climbed all the way to the filesystem root with no ceiling, so a stray
  `~/node_modules/.bin/<tool>.cmd` (for example one a home-level manifest
  installs) could be picked up as the current project's local install even
  though it has nothing to do with the project. The walk now stops at (or
  above) your home directory, the same ceiling project-root discovery already
  applies — a project's own bin still resolves normally as long as it sits
  below your home directory. On Windows the ceiling also now recognises your
  home directory when the path is spelled with the other drive-letter case
  (`c:\Users\…` as VS Code reports it), which previously let the walk climb
  straight past it; the same fix applies to every other search that stops at
  your home directory, including project-root and tool-config discovery. The
  ceiling now covers every project-local tool-bin lookup, not just the
  formatter one: Vite+'s `vp` for the oxlint runner, the ast-grep availability
  sweep's project-local check, and Composer `vendor/bin` tools such as
  phpstan — all of which previously climbed past your home directory. The
  ast-grep availability sweep also checks pi-lens's OWN install directory
  (deliberately NOT ceilinged there — a `pi install npm:pi-lens` install can
  legitimately sit at your home directory itself), so pi-lens's bundled
  `@ast-grep/cli` keeps resolving regardless of where pi-lens itself is
  installed. On Windows, a virtualenv that somehow contains BOTH layouts
  (ruff/sqlfluff) now prefers the runnable `Scripts\<tool>.exe` over
  `bin\<tool>` consistently everywhere. The Python venv lookups behind
  ruff/sqlfluff/vulture stay fixed lookups at the project directory, as
  before — they do not check ancestor directories.
