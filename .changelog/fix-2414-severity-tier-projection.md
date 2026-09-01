---
section: Fixed
---

- **Stop presenting hint/info findings as code warnings (refs #2414)** — the TUI footer, `lens_diagnostics` (mode=all/full), and every compact finding-count surface now project severity through one shared classifier: `hint`/`info` tier findings (style opinions such as `no-runtime-typeof`, complexity hints) no longer inflate the `warnings` count or the footer's `!NW` chip. They stay visible everywhere that matters — the detailed diagnostics list, a new `advisories` count so a hint-only file isn't silently dropped from a listing, and a distinct "N hints" line in `lens_diagnostics`' summary — they just never share the warning tally with real, bounded-false-positive-rate warnings.
