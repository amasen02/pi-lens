---
section: Added
---

- **Shared config core (refs #2425).** `clients/config-core/` is now the one place a pi-lens configuration is validated, merged, and explained: a schema-driven validate/normalize pipeline that warns and drops unknown fields under the stable `PILENS_CFG_0004`/`PILENS_CFG_0005` codes, a field-wise merger with per-node `x-merge-strategy` (`replace`/`append`/`keyed:<field>`), per-leaf provenance across the seven source tiers, monotonic deny precedence so a repository config can never re-enable what an operator disabled, and a trust-gated `ProcessSpec` whose `toSpawnArgs` refuses a project-supplied command unless both the recorded and the live host trust decisions say `trusted`. Diagnostic projections are redacted by construction — no env value and no argv tail survives them. No loader is wired to it yet, so there is no user-visible behavior change in this release; `docs/public-api-stability.md` section 5 documents the semantics the loaders will adopt.
