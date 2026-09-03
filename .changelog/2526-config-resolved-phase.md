---
section: Added
---

- **Config resolution now proves it happened (closes #2526)** — one `config_resolved` latency phase per session (and per warm MCP boot) records the redacted `documents[]` (`{tier, file, legacy}`), `countsByTier`, `recordCount`, `deniedServers` and `resolveMs`, with a matching `config resolved …` line in `sessionstart.log`. Written where the resolution already exists — `loadLSPConfig`, the one funnel every production resolution goes through — so nothing is resolved twice and the session-start hook path gains no await. The payload comes from `summarizeConfigResolution`, the same projection `pilens_effective_config` embeds, so the on-demand answer and the session record cannot drift. `npm run logs:smells` gains a `config-resolution` smell for session starts with no record and for a legacy config document that produced zero migration records.
