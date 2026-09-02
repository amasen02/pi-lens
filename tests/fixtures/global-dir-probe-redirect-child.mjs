// This fixture imports the COMPILED `clients/*.js` output (relative imports
// below), not the `.ts` sources — it deliberately mirrors a real ad-hoc probe
// against the built extension rather than vitest's own hermetic harness. Run
// `npm run build` before running this file directly or via a focused
// `vitest run tests/config/global-dir-probe-redirect.test.ts` — otherwise it
// exercises stale compiled code.
//
// Deliberately spawned with NO `PI_LENS_HOME`/`VITEST`/`PI_LENS_TEST_MODE` in
// its environment (see the parent test's `runChild`) and a `cwd` under a
// `.claude/worktrees/...` segment — the exact "forgot to pin PI_LENS_HOME"
// shape #2506 is about. `recordDegradationOnce` here is the reviewer's
// forensic fixture: a `config-ignored` row shaped like the ones that leaked
// into the maintainer's real `~/.pi-lens/latency.log` on 2026-09-02.
import { recordDegradationOnce } from "../../clients/degradation-ledger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";

recordDegradationOnce({
	kind: "config-ignored",
	subject: "C:/p/.pi-lens.json/section3/__proto__",
	reason: "probe fixture (#2506 regression test)",
});

await flushLatencyLog();

process.stdout.write(`global-dir:${getGlobalPiLensDir()}\n`);
