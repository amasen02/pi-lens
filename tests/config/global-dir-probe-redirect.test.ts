import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #2506 round 2: an ad-hoc probe against the BUILT `clients/*.js` (a bare
// `node -e`, a throwaway `.mjs`, a harness script run OUTSIDE vitest) has no
// test-mode gate and no `PI_LENS_HOME` pin, so `getGlobalPiLensDir()` used to
// fall straight through to `os.homedir()`. Confirmed live: two review probes
// wrote 42 `config-ignored` rows into the maintainer's real
// `~/.pi-lens/latency.log` on 2026-09-02. A REAL child `node` process is
// load-bearing here — an in-process call can't exercise "PI_LENS_HOME was
// never set in this process's environment" the way a freshly spawned child
// can; mocking `process.env`/`process.cwd()` in-process would test the mock,
// not the production import-time resolution in
// `latency-logger.ts`/`file-utils.ts`.
//
// Safety: every child below gets its OWN throwaway `USERPROFILE`/`HOME`
// (verified live on this Node/Windows combination: `os.homedir()` honors an
// overridden `USERPROFILE`), standing in for "the real home" the reviewer's
// canary describes. This is deliberate, not a weaker substitute for the real
// `os.homedir()` — the pre-fix code path this test proves red against
// resolves straight to `os.homedir()` with no other gate, so running that
// proof against the ACTUAL developer machine home would reproduce the exact
// #2506 incident (42 fixture rows in real telemetry) as a side effect of
// proving the bug exists. Faking the home directory exercises the identical
// `path.join(os.homedir(), ".pi-lens")` branch — the code never distinguishes
// a real profile from a faked one — while keeping the proof itself hermetic.
const CHILD_FIXTURE = fileURLToPath(
	new URL("../fixtures/global-dir-probe-redirect-child.mjs", import.meta.url),
);
const CHILD_TIMEOUT_MS = 15_000;

interface ChildResult {
	stdout: string;
	stderr: string;
}

function runChild(
	cwd: string,
	fakeHome: string,
	extraEnv: Record<string, string> = {},
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// The exact hazard: no home pin, no test-mode signal — a bare probe run
		// inherits the ambient shell environment minus these.
		delete env.PI_LENS_HOME;
		delete env.VITEST;
		delete env.PI_LENS_TEST_MODE;
		delete env.PILENS_PROBE;
		delete env.PILENS_DATA_DIR;
		// Stand in for "the real home" without touching this machine's actual
		// profile — see the file-level comment.
		env.USERPROFILE = fakeHome;
		env.HOME = fakeHome;
		Object.assign(env, extraEnv);

		const child = spawn(process.execPath, [CHILD_FIXTURE], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`probe child timed out after ${CHILD_TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
				),
			);
		}, CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						`probe child exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function parseGlobalDir(stdout: string): string {
	const line = stdout
		.split(/\r?\n/)
		.find((candidate) => candidate.startsWith("global-dir:"));
	if (!line) {
		throw new Error(`child stdout carried no global-dir line: ${stdout}`);
	}
	return line.slice("global-dir:".length).trim();
}

describe("getGlobalPiLensDir probe-home redirect (#2506)", () => {
	it("redirects a PI_LENS_HOME-less probe run from a worktree cwd away from the (fake) real home, never touching it", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-probe-redirect-"),
		);
		const probeCwd = path.join(tempRoot, ".claude", "worktrees", "agent-x");
		const fakeHome = path.join(tempRoot, "fake-real-home");
		fs.mkdirSync(probeCwd, { recursive: true });
		fs.mkdirSync(fakeHome, { recursive: true });

		const canaryLog = path.join(fakeHome, ".pi-lens", "latency.log");

		try {
			const { stdout } = await runChild(probeCwd, fakeHome);
			const globalDir = parseGlobalDir(stdout);

			const expectedProbeHome = path.join(probeCwd, ".pi-lens-probe-home");
			expect(globalDir).toBe(expectedProbeHome);
			expect(globalDir).not.toBe(path.join(fakeHome, ".pi-lens"));

			// The degradation row actually landed under the redirected probe home.
			const probeLatencyLog = path.join(globalDir, "latency.log");
			expect(fs.existsSync(probeLatencyLog)).toBe(true);
			const body = fs.readFileSync(probeLatencyLog, "utf8");
			expect(body).toContain("config-ignored");
			expect(body).toContain("/p/.pi-lens.json");

			// The real-home canary (here, the fake stand-in for it) was never
			// created — the pre-fix code would have written straight into it.
			expect(fs.existsSync(canaryLog)).toBe(false);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 20_000);

	it("PILENS_PROBE=1 forces the same redirect from an ordinary (non-worktree) cwd", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-probe-force-"),
		);
		// Deliberately NOT under .claude/worktrees/ or os.tmpdir() itself — an
		// ordinary project checkout dir the implicit cwd heuristic would not
		// catch on its own; only the explicit PILENS_PROBE=1 force applies here.
		const ordinaryCwd = path.join(tempRoot, "ordinary-project");
		const fakeHome = path.join(tempRoot, "fake-real-home");
		fs.mkdirSync(ordinaryCwd, { recursive: true });
		fs.mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout } = await runChild(ordinaryCwd, fakeHome, {
				PILENS_PROBE: "1",
			});
			const globalDir = parseGlobalDir(stdout);
			expect(globalDir).toBe(path.join(ordinaryCwd, ".pi-lens-probe-home"));
			expect(fs.existsSync(path.join(fakeHome, ".pi-lens"))).toBe(false);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 20_000);
});
