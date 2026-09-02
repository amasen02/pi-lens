- Config migration notices now name only settings pi-lens recognizes: a key in
  a legacy config file that is not a pi-lens setting no longer gets "move it
  to ..." advice it cannot act on, and the unrecognized keys are summarised in
  one whole-file notice instead. The number of notices any one config file can
  produce is bounded, with the suppressed count reported as `PILENS_CFG_0007`
  rather than dropped silently (refs #2426).
- A legacy root LSP key (`servers`, `serverOverrides`, `disabledServers`,
  `warmFiles`) in `~/.pi-lens/config.json` is no longer both applied and called
  a typo in the same session — it gets the migration notice only (refs #2426).
- A malformed `~/.pi-lens/config.json` is now reported by the global config
  loader itself, as a global-config problem, instead of being silently dropped
  and mislabelled "invalid LSP config" by the LSP loader (closes #2445).
- The half-migrated warnings for a legacy `pi-lens.json` sitting beside or above
  a canonical `.pi-lens.json` are now produced by the pi-lens config loader, so
  they still appear under `--no-lsp`, `lsp.enabled: false`, and in subagent
  sessions (refs #2426).
- A repeat load of an unchanged config file replays its ignored-setting warnings
  as well as its deprecation warnings, so the durable `config-ignored` record no
  longer disappears after the session that first parsed the file (refs #2426).
