---
section: Changed
---

- **A formatter installed only at your home directory is no longer used as a project's formatter (closes #2514)** — `findInNodeModules`'s ancestor walk
  (`clients/formatters.ts`, and the shared `findLocalBinUpwards` it now
  delegates to in `clients/package-manager.ts`) climbed all the way to the
  filesystem root with no ceiling, so a stray
  `~/node_modules/.bin/<tool>.cmd` (for example one a home-level manifest
  installs) could be picked up as the current project's local install even
  though it has nothing to do with the project. The walk now stops at (or
  above) your home directory, the same ceiling `findNearestMarkerRoot`
  already applies to project-root discovery — a project's own
  `node_modules/.bin`, `vendor/bin`, or `.venv`/`venv` bin still resolves
  normally as long as it sits below your home directory.
