# Configuring pi-lens

There are **two** pi-lens config files:

| File | Scope | Notes |
| --- | --- | --- |
| `.pi-lens.json` | the project | Committed or not, your call. Nearest one wins **per field** — a package can override one setting without restating the repo root's. |
| `~/.pi-lens/config.json` | the machine | Your defaults across every project. `PI_LENS_CONFIG_PATH` relocates it. |

Both files have the same shape, with one exception noted below the example:
everything LSP-related lives under an `lsp` namespace inside them.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/apmantza/pi-lens/master/docs/schema/pi-lens-config-v1.json",
  "ignore": ["dist/**"],
  "maxProjectFiles": 8000,
  "rules": { "high-complexity": { "threshold": 25 } },
  "lsp": {
    "disabledServers": ["typos"],
    "warmFiles": ["src/main.rs"],
    "servers": {
      "my-server": {
        "name": "My Custom LSP",
        "extensions": [".myext"],
        "command": "my-lsp-server",
        "args": ["--stdio"]
      }
    },
    "serverOverrides": {
      "rust": {
        "initializationOptions": { "check": { "command": "clippy" } }
      }
    }
  }
}
```

**Some settings are global-only.** A handful of switches — `lsp.enabled`
(`--no-lsp`), `tests.enabled`, `delta.enabled` and the other session-wide
toggles — are decided once for the machine, not per project, so writing one in a
`.pi-lens.json` does nothing. It is not ignored quietly: the project loader says
so, naming the key. `docs/settings.md` lists which flags are which.

## Which file wins

One order, lowest precedence first. A later tier replaces an earlier tier's
value **for that field only** — objects are merged field-wise, never replaced
whole, so setting one key never silently drops the rest of a section.

1. **global** — `~/.pi-lens/config.json`.
2. **project root** — the outermost `.pi-lens.json` at or above your working
   directory.
3. **nested-project** — every `.pi-lens.json` between that root and your working
   directory, outermost first. The nearest file wins, per field.

Those three are the tiers the config **files** resolve through, and they are the
only ones this resolution populates. Four more tiers are reserved in the
precedence table — `builtin` below them, and `env`, `cli`, `host` above — and
nothing writes into them yet; #2427 (env/CLI) and #2416 (host and project trust)
are what fill them in.

Until they do, environment variables and CLI flags are read by their own
accessors rather than through this resolution, and their effective precedence
for a pi-lens toggle is:

1. a `PI_LENS_*` environment variable set to `1` — checked first, and it wins
   outright;
2. the matching `--lens-*` / `--no-*` CLI flag;
3. the nearest project `.pi-lens.json`, then the outer ones (project-scoped
   settings only);
4. `~/.pi-lens/config.json`;
5. the built-in default.

Subsystem-specific env overrides follow the same shape: a
`PI_LENS_REVIEW_GRAPH_MAX_FILES` beats a `.pi-lens.json`'s
`reviewGraph.maxFiles`. `docs/environment-variables.md` and `docs/settings.md`
are the per-setting references.

Two rules make the rest of the table unambiguous:

- **The search stops at `$HOME`.** pi-lens never reads a config file in your
  home directory or above it. A stray `pi-lens.json` in `$HOME` (or at `C:\`)
  is not adopted by every project on the machine. The machine-global file is
  read by its own path, so it is unaffected.
- **The canonical spelling wins.** Where a legacy file or a legacy key means the
  same thing as the canonical one, the canonical one is used — otherwise the
  migration below could never be completed.

## Legacy locations (still read; being removed)

These are read for their deprecation window and then **removed**. Each one you
still have produces one warning per setting, naming exactly where to move it —
carrying the stable code `PILENS_CFG_0003` (a deprecated file) or
`PILENS_CFG_0002` (a deprecated key), so you can match or suppress on the code
rather than on the prose.

| Legacy | Move it to | Code |
| --- | --- | --- |
| `.pi-lens/lsp.json` | `.pi-lens.json` → `lsp.*` | `PILENS_CFG_0003` |
| `pi-lsp.json` | `.pi-lens.json` → `lsp.*` | `PILENS_CFG_0003` |
| `pi-lens.json` (undotted) | `.pi-lens.json` | `PILENS_CFG_0003` |
| `~/.pi-lens/lsp.json` | `~/.pi-lens/config.json` → `lsp.*` | `PILENS_CFG_0003` |
| `servers` at the file root | `lsp.servers` | `PILENS_CFG_0002` |
| `serverOverrides` at the file root | `lsp.serverOverrides` | `PILENS_CFG_0002` |
| `disabledServers` at the file root | `lsp.disabledServers` | `PILENS_CFG_0002` |
| `warmFiles` at the file root | `lsp.warmFiles` | `PILENS_CFG_0002` |

**Deprecated since 4.2.0. Read for the last time before 5.0.0.** The window is
declared as data in `clients/config-diagnostic-codes.ts`
(`DEPRECATED_CONFIG_SURFACES`) and enforced by test, so the schedule above and
the code cannot drift apart. `docs/public-api-stability.md` describes the policy
these dates instantiate.

A `.pi-lens.json` that mixes both spellings is fine while you migrate: the
canonical key wins, and the keys you have not moved yet keep working.

Only keys pi-lens actually recognizes get "move it to …" advice. A key in a
legacy file that is not a pi-lens setting at all — a typo, or a leftover from
another tool — cannot be migrated anywhere, so it gets the ordinary
unrecognized-key notice (`PILENS_CFG_0001`) and is counted in ONE whole-file
`PILENS_CFG_0003` notice for the file rather than being told to move.

## When a config is ignored

A file that cannot be read or parsed is **ignored, never partially applied** —
pi-lens runs on defaults for it and says so once, with the code
`PILENS_CFG_0001`. A field whose value does not match its declared type is
dropped on its own (`PILENS_CFG_0005`), and an unrecognized field is dropped
with a message naming the key (`PILENS_CFG_0004`). If resolving a file fails
internally the whole file is ignored and said so under its own code
(`PILENS_CFG_0008`), so "one field went missing" and "none of this file is in
effect" are never the same code. Nothing about your config is ever ignored
silently.

The number of notices one file can produce is bounded PER NOTICE CLASS —
deprecations, and rejected values — each at 19 notices plus 1 summary, because
the number of keys in a file is not bounded. Past the bound the remainder is
summarised in a single `PILENS_CFG_0007` notice giving the count that was
suppressed, so a truncated list always says that it is truncated. That notice
is about the LIST, not about the file: a config whose every setting was applied
can still overflow the bound, so it is worded and recorded as a summary rather
than as an ignored config.

## See also

- `docs/globalconfig.md` — every key of `~/.pi-lens/config.json`, in detail.
- `docs/settings.md` — the CLI flags and what they map to.
- `docs/environment-variables.md` — the `PI_LENS_*` tier.
- `docs/public-api-stability.md` — what `x-stability`, the `PILENS_CFG_*` codes,
  and the deprecation windows commit pi-lens to.
