---
section: Changed
---

- **`symbol_search`'s `lang` filter answers from the registry (refs #2424)** — it was a ninth hand-written language-to-extensions table in `clients/lens-engine.ts` and had drifted from every other one. Reconciled: `css` no longer claims `.scss`/`.less` and `json` no longer claims `.jsonc` (those are their own languages, parse under no css/json grammar, and have no symbol queries, so no real hit is hidden); `php` gains `.phtml`/`.php3`/`.php4`/`.php5`, `ruby` gains `.ru`, `bash` gains `.zsh` and `cpp` gains the rest of the C++ extension family; `solidity` is dropped — pi-lens ships no solidity grammar and no ast-grep binding for it, so a `.sol` file could never carry an indexed symbol. A `lang` value may now be spelled as either the tree-sitter grammar name or the canonical language id.
