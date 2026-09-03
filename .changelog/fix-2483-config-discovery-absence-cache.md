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
  in `startDir` bumps its own mtime and is found on the very next load.
  **Round 2**: a file created further up the chain moves nothing `startDir`-scoped
  freshness tracks, and — with no production caller of
  `resetProjectLensConfigCache` and a same-`startDir` load never rediscovering
  — that left staleness unbounded, violating the issue's own acceptance line
  ("a new config file created in the chain IS noticed (bounded staleness
  stated)"). Fixed by reusing `file-utils.ts`'s existing negative-cache
  cadence bound (`FRESHNESS_CADENCE_MS`, extracted to the shared leaf
  `clients/freshness-cadence.ts` so both modules read one value without a
  `clients/` import cycle): a no-config discovery entry force-expires at
  most once per 2s cadence window regardless of `startDir`'s own mtime,
  which sends the next load through a full ancestor re-walk — so a config
  created anywhere in the chain is noticed within one cadence window, not
  never.
  Regression tests added to `tests/clients/config-discovery-cost.test.ts`
  alongside the existing presence-case coverage: 500 warm loads with no
  config found cost a constant 1 stat each (proven red pre-fix at
  `[8, 54]`/`[54, 8]`, matching the issue's reported growth), ancestor churn
  above `startDir` does not re-walk (proven red pre-fix at `warm=6` /
  `after=38`, matching the issue's own probe numbers exactly), a config file
  newly created directly in `startDir` is still noticed, and (round 2) a
  config file created two levels above `startDir` is not noticed within the
  cadence window but is noticed once it elapses.
