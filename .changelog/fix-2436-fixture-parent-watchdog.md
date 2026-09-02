---
section: Fixed
---

- **`tests/fixtures/fake-lsp-server.mjs` can no longer outlive a killed parent (refs #2436)** — a real orphan of this fixture was found running an hour after the test that spawned it finished, its parent process long gone, holding its worktree directory open (`git worktree remove` → Permission denied). The fixture now self-terminates on stdin EOF and on a parent-liveness poll (`process.kill(originalPpid, 0)`, ≤1s), so it cannot survive a SIGKILLed parent even when no JS-level teardown ever runs. Every test spawn of the fixture now routes through one helper (`tests/support/fake-lsp-server.ts`) that also registers a guaranteed `onTestFinished` kill as a backstop. `tests/support/fault-injection.ts`'s `spawnWedgedChild` (the same "long-running spawn, caller-owned lifetime" shape) got the same backstop.
