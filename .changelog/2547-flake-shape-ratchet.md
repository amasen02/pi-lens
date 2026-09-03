---
section: Added
---

- **Add a flake-shape ratchet over `tests/**/*.test.ts` (closes #2547)** —
  three deflake PRs in two days (#2531 alone fixed three shared-slot races)
  and nothing counted the contention surface those PRs kept fixing.
  `tests/clients/flake-shape-ratchet.test.ts` now caps three shapes per file,
  content-keyed against `tests/support/flake-shape-baseline.json`: a real
  child process (`child_process` import, `execFileSync`/`spawnSync`/
  `execSync`, or a spawn whose argv mentions `vitest`), a DELTA of two clock
  reads (`Date.now`/`performance.now`/`process.hrtime`) feeding a numeric
  matcher, and a raw `setTimeout`/`setInterval` wait outside
  `vi.useFakeTimers()`. A new file or a risen count in an existing one fails
  the ratchet unless it carries a `// flake-shape: <detector> — <reason>`
  header and is added to `vitest.config.ts`'s `wallClockBudgetInclude`.
  AGENTS.md's "Test requirements" states the default (fake clocks and the
  interleaving kit; a real spawn or wall-clock assertion is a stated boundary
  decision), and the fixer/reviewer playbooks each carry a matching line.
