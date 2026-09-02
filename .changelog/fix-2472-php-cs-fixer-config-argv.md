---
section: Fixed
---

- **php-cs-fixer now carries its detected ancestor config into `--config` (closes #2472)** — php-cs-fixer's own `ConfigurationResolver` does not walk
  up parent directories looking for `.php-cs-fixer.php`/`.php-cs-fixer.dist.php`
  the way prettier/biome/eslint do, and pi-lens spawns it with the FORMATTED
  FILE's own directory as its working directory — so a config found several
  directories above (the common project-root layout) was invisible to the
  actual `fix` invocation, and php-cs-fixer silently fell back to its
  built-in default ruleset instead of the project's configured one. The
  nearest ancestor config is now resolved and passed explicitly via
  `--config <path>`, with `.php-cs-fixer.php` preferred over
  `.php-cs-fixer.dist.php` in the same directory (matching php-cs-fixer's
  own precedence) — including when the config sits in the file's own
  directory, so correctness no longer depends on php-cs-fixer's own
  (nonexistent) upward search.
