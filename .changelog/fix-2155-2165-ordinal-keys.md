---
section: Fixed
---

- **Identity-feeding sorts now use a code-unit comparator, not `localeCompare` (closes #2155, closes #2165)** — the availability-probe cache key in `runner-helpers.ts` sorted env entries with `localeCompare`, a locale-dependent comparator. Two processes (or one process under a changed locale) could order the same env set differently and mint different keys for identical state, causing a silent probe-dedupe miss. Fixed via a new shared `compareOrdinal` helper (`clients/string-utils.ts`), applied to every identity-feeding sort found in the class sweep: dependency-cycle and madge dedupe keys, review-graph signature/hash/cache keys, the Windows spawn cache key, the bounded-hash object-key order, the rule-cache content hash, the workspace-diagnostics scope key, the turn-end-findings signature, and the formatter-config signature. `localeCompare` sorts kept for user-facing display are left untouched.
