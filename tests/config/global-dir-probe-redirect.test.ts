import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #2506 round 2: an ad-hoc probe against the BUILT `clients/*.js` (a bare
// `node -e`, a throwaway `.mjs`, a harness script run OUTSIDE vitest) has no
// test-mode gate and no `PI_LENS_HOME` pin, so `getGlobalPiLensDir()` used to
// fall straight through to the real `~/.pi-lens`. Confirmed live: two review
// probes wrote 42 `config-ignored` rows into the maintainer's real
// `latency.log` on 2026-09-02. A REAL child `node` process is load-bearing
// here — an in-process call can't exercise "PI_LENS_HOME was never set in
// this process's environment" the way a freshly spawned child can; mocking
// `process.env`/`process.cwd()` in-process would test the mock, not the
// production import-time resolution in `latency-logger.ts`/`file-utils.ts`.
const CHILD_FIXTURE = fileURLToPath(
	new URL(
		"../fixtures/global-dir-probe-redirect-child.mjs",
		import.meta.url,
	),
);
const CHILD_TIMEOUT_MS = 15_000;

function runChild(
	cwd: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// The exact hazard: no home pin, no test-mode signal, no probe force —
		// a bare probe run inherits the ambient shell environment minus these.
		delete env.PI_LENS_HOME;
		delete env.VITEST;
		delete env.PI_LENS_TEST_MODE;
		delete env.PILENS_PROBE;
		delete env.PILENS_DATA_DIR;

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

describe("getGlobalPiLensDir probe-home redirect (#2506)", () => {
	it("redirects a PI_LENS_HOME-less probe run from a worktree cwd away from the real home, never touching it", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-probe-redirect-"),
		);
		const probeCwd = path.join(tempRoot, ".claude", "worktrees", "agent-x");
		fs.mkdirSync(probeCwd, { recursive: true });

		const realHomeLog = path.join(os.homedir(), ".pi-lens", "latency.log");
		const beforeExists = fs.existsSync(realHomeLog);
		const beforeMtimeMs = beforeExists
			? fs.statSync(realHomeLog).mtimeMs
			: null;

		try {
			const { stdout } = await runChild(probeCwd);
			const globalDirLine = stdout
				.split(/\r?\n/)
				.find((line) => line.startsWith("global-dir:"));
			expect(globalDirLine, `child stdout: ${stdout}`).toBeDefined();
			const globalDir = globalDirLine!.slice("global-dir:".length).trim();

			const expectedProbeHome = path.join(probeCwd, ".pi-lens-probe-home");
			expect(globalDir).toBe(expectedProbeHome);
			expect(globalDir).not.toBe(path.join(os.homedir(), ".pi-lens"));

			// The degradation row actually landed under the redirected probe home.
			const probeLatencyLog = path.join(globalDir, "latency.log");
			expect(fs.existsSync(probeLatencyLog)).toBe(true);
			const body = fs.readFileSync(probeLatencyLog, "utf8");
			expect(body).toContain("config-ignored");
			expect(body).toContain("/p/.pi-lens.json");

			// The real-home canary is untouched — same mtime (or still absent).
			const afterExists = fs.existsSync(realHomeLog);
			expect(afterExists).toBe(beforeExists);
			if (beforeExists) {
				expect(fs.statSync(realHomeLog).mtimeMs).toBe(beforeMtimeMs);
			}
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 20_000);

	it("PILENS_PROBE=1 forces the same redirect from an ordinary (non-worktree) cwd", async () => {
		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-probe-force-"),
		);
		// Deliberately NOT under .claude/worktrees/ or a tmp segment pattern the
		// implicit heuristic would catch on its own path shape — an ordinary
		// project checkout dir.
		const ordinaryCwd = path.join(tempRoot, "ordinary-project");
		fs.mkdirSync(ordinaryCwd, { recursive: true });

		try {
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env.PI_LENS_HOME;
			delete env.VITEST;
			delete env.PI_LENS_TEST_MODE;
			env.PILENS_PROBE = "1";
			delete env.PILENS_DATA_DIR;

			const stdout = await new Promise<string>((resolve, reject) => {
				const child = spawn(process.execPath, [CHILD_FIXTURE], {
					cwd: ordinaryCwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				let err = "";
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (c: string) => {
					out += c;
				});
				child.stderr.on("data", (c: string) => {
					err += c;
				});
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`timed out\nstdout: ${out}\nstderr: ${err}`));
				}, CHILD_TIMEOUT_MS);
				child.once("error", (e) => {
					clearTimeout(timer);
					reject(e);
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					if (code !== 0) {
						reject(new Error(`exited ${code}\nstdout: ${out}\nstderr: ${err}`));
						return;
					}
					resolve(out);
				});
			});

			const globalDirLine = stdout
				.split(/\r?\n/)
				.find((line) => line.startsWith("global-dir:"));
			expect(globalDirLine, `child stdout: ${stdout}`).toBeDefined();
			const globalDir = globalDirLine!.slice("global-dir:".length).trim();
			expect(globalDir).toBe(path.join(ordinaryCwd, ".pi-lens-probe-home"));
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 20_000);
});
