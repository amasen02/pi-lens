---
section: Fixed
---

- **rustfmt now carries the Cargo package edition (closes #2466)** — rustfmt
  was invoked bare (`rustfmt <file>`), so it parsed under its own default
  edition instead of the file's actual Cargo package edition and could reject
  valid newer-edition syntax (e.g. Rust 2024). The nearest package's
  `[package] edition` (or its inherited `[workspace.package] edition` when the
  package declares `edition.workspace = true`) is now resolved and passed
  through `--edition`.
