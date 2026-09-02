---
section: Fixed
---

- **Stop `*-logger.ts` writers from freezing their log path at module-import time (closes #2506)** —
  `latency-logger.ts`, `extension-log.ts`, and eleven
  other machine-global loggers used to resolve `getGlobalPiLensDir()` (which
  reads `PI_LENS_HOME`) into a top-level `const`, evaluated once at import
  time. Whichever process imported the module first froze every later write
  to whatever `PI_LENS_HOME` was live at that moment — confirmed live via a
  canary in vitest's `globalSetup`, which runs before the per-worker
  `PI_LENS_HOME` pin is set. Every writer now defers construction to its
  first real call (`clients/ndjson-logger.ts`'s new `createLazyNdjsonLogger`),
  so the resolved path always reflects the CURRENT env rather than whatever
  was true at import. `tests/support/vitest-setup.ts` also now pins
  `PILENS_DATA_DIR` alongside `PI_LENS_HOME`, and a new governance suite
  (`tests/config/log-path-lazy-resolution.test.ts`) asserts no writer can
  resolve under the real `os.homedir()` once a test run starts.
