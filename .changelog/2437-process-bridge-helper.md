---
section: Changed
---

- **One shared registration helper for the read and mutation bridges (refs #2437, refs #2423)** — `clients/read-bridge.ts` and `clients/mutation-bridge.ts` each hand-rolled an identical mount body (a first-wins existence check, `Object.freeze`, and a non-writable/non-configurable `Object.defineProperty` at a `globalThis` `Symbol.for` key). New leaf module `clients/process-bridge.ts` (`registerProcessBridge`/`getProcessBridge`) owns that body once; both bridges now delegate and are thin declarations of their own method table and version check. No behavior change — both bridges' existing test suites pass unchanged.
