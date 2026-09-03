---
section: Fixed
---

- **Project-config discovery with no config file anywhere is bearing-scoped, not $HOME-wide (refs #2426, closes #2483)** —
  `bearingDirMtimes` in `clients/project-lens-config.ts` scopes a discovery
  cache entry's directory-mtime freshness to the BEARING chain — `startDir` up
  to and including the directory that supplied the winning config file — when
  a config file is found (warm load = 3 stats, unrelated ancestor churn
  ignored, per #2426 round 5, F-C). When no config is found anywhere — the
  majority case for most projects — the fallback returned the FULL chain to
  the `$HOME` ceiling, so an unrelated mtime change in any ancestor (`~/Desktop`,
  `~/projects`) invalidated the entry and forced a full re-walk, re-read and
  re-parse of every legacy document, on every subsequent load. Live evidence
  from the #2456 round-5 review: warm = 6 stats, after ancestor churn = 38.
  Fix: when no config is found, freshness is scoped to `startDir` itself —
  the nearest directory a config file COULD have appeared in, the same
  bearing-directory principle the presence case already applies (a directory
  is always its own degenerate bearing chain). A config file created directly
  in `startDir` bumps its own mtime and is found on the very next load;
  bounded staleness is accepted for one created further up the chain, until
  some other invalidation (`resetProjectLensConfigCache`, or a load from a
  different `startDir`) reaches it — strictly narrower than the pre-fix "any
  ancestor up to `$HOME` invalidates".
  Regression tests added to `tests/clients/config-discovery-cost.test.ts`
  alongside the existing presence-case coverage: 500 warm loads with no
  config found cost a constant 1 stat each (proven red pre-fix at
  `[8, 54]`/`[54, 8]`, matching the issue's reported growth), ancestor churn
  above `startDir` does not re-walk (proven red pre-fix at `warm=6` /
  `after=38`, matching the issue's own probe numbers exactly), and a config
  file newly created directly in `startDir` is still noticed.
