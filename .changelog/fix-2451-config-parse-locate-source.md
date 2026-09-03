---
section: Changed
---

- **Config parse errors keep `line L col C` locality for every V8 `SyntaxError` shape, derived from the source text instead of the message (refs #2451)** —
  #2431's redaction fix stripped a `JSON.parse` `SyntaxError#message` down to
  the error's own class, plus a position when V8's message stated one
  (`at position N (line L column C)`). V8's OTHER shape — `Unexpected token
  'x', "<snippet>"... is not valid JSON`, the exact shape #2431's own
  evidence hit (a `ghp_`-prefixed token) — states no position at all, so a
  user hand-editing `.pi-lens.json` got strictly LESS locality than before
  #2431: a bare `SyntaxError`, no line, no column. `clients/config-warn.ts`'s
  `normalizeParseErrorReason` now accepts the raw source text the loaders
  already read and locates the error IN IT: V8's own quoted snippet is found
  in the source with `indexOf` (a match that is not unique is not trusted),
  and the offending token's own offset is used when it too is unique inside
  the snippet — an EXACT position, not an approximation, for the common case
  (JSON punctuation, a typo'd letter). Line/col are then computed by
  scanning the source ourselves — for BOTH shapes, so even the
  position-stated one is no longer trusting V8's own digits, only ours.
  Only digits ever escape into the reason string; the snippet and the token
  text never do. `clients/config-resolve.ts`'s `readConfigDocument` now
  carries the text it read alongside a `JSON.parse` failure
  (`ConfigReadOutcome`/`ConfigReadFailure`'s new optional `sourceText`,
  unset for an `fs` read failure — nothing was ever read then), threaded
  through `reportConfigReadFailure` and `ignoredRecordCollector`'s
  `NoteIgnored` to every one of the three loaders (`clients/lsp/config.ts`,
  `clients/lens-config.ts`, `clients/project-lens-config.ts`).

  Also folds three near-identical inline copies of
  `error instanceof Error ? error.name : "unknown error"`
  (`clients/config-core/normalize.ts`, `clients/config-core/resolve.ts`, and
  a third `clients/lens-config.ts` grew independently since #2431) onto a
  new zero-dependency leaf, `clients/error-class.ts`'s `errorClassName` —
  NOT `normalizeParseErrorReason` itself, which the issue's evidence
  proposed: `config-core/` must never import a sink
  (`clients/config-warn.ts` -> the degradation ledger), which is exactly the
  import-cycle removal #2426 shipped for that module, and importing
  `normalizeParseErrorReason` back in would reopen it. `normalizeParseErrorReason`
  gained a `classOnly` option that delegates to the same leaf, so every
  caller of "class name, never the message" — including `config-warn.ts`'s
  own — now shares one implementation.
