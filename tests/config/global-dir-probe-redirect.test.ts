import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getGlobalPiLensDir,
	getGlobalPiLensLogDir,
} from "../../clients/file-utils.js";
import {
	_resetProbeHomeRedirectStateForTests,
	getProbeHomeResolution,
	PROBE_HOME_RESOLUTION_KEY,
} from "../../clients/probe-home-state.js";

// #2506: an ad-hoc probe against the BUILT `clients/*.js` (a bare `node -e`, a
// throwaway `.mjs`, a harness script run OUTSIDE vitest) has no test-mode gate
// and no `PI_LENS_HOME` pin, so the log resolver used to fall straight through
// to `os.homedir()`. Confirmed live: two review probes wrote 42
// `config-ignored` rows into the maintainer's real `~/.pi-lens/latency.log` on
// 2026-09-02. A REAL child `node` process is load-bearing here — an in-process
// call can't exercise "PI_LENS_HOME was never set in this process's
// environment" the way a freshly spawned child can; mocking `process.env` /
// `process.cwd()` in-process would test the mock, not the production
// import-time resolution in `latency-logger.ts`/`file-utils.ts`.
//
// ROUND 3, F3 — why each case steers the child's `os.tmpdir()`. Round 2 rooted
// every fixture under `os.tmpdir()`, so the worktree case and the
// `PILENS_PROBE=1` case were BOTH also satisfied by the tmpdir branch: all
// three branches were individually vacuous and deleting any one of them left
// the suite green. Fixtures still live in the real temp dir (that is where
// throwaway trees belong), but each child is given its own
// `TEMP`/`TMP`/`TMPDIR` so that `os.tmpdir()` inside it points somewhere that
// does or does not contain the fixture, exactly as the case requires. This is
// real Node behaviour — `os.tmpdir()` reads those variables — so the branch
// under test sees a genuine `os.tmpdir()`, not a stub. Every case asserts on
// the child's reported `tmpdir:` line, so a fixture that drifts back under the
// child's temp dir fails loudly instead of going quietly vacuous.
//
// Safety: every child below gets its OWN throwaway `USERPROFILE`/`HOME`
// (verified live on this Node/Windows combination: `os.homedir()` honors an
// overridden `USERPROFILE`), standing in for "the real home". This is
// deliberate, not a weaker substitute: the pre-fix path resolves straight to
// `os.homedir()` with no other gate, so running the proof against the ACTUAL
// developer home would reproduce the exact #2506 incident as a side effect of
// proving the bug exists. The code path is identical either way —
// `path.join(os.homedir(), ".pi-lens")` never distinguishes a real profile
// from a faked one.
const CHILD_FIXTURE = fileURLToPath(
	new URL("../fixtures/global-dir-probe-redirect-child.mjs", import.meta.url),
);
const CHILD_TIMEOUT_MS = 30_000;
const REPO_ROOT = path.resolve(".");

interface ChildFacts {
	tmpdir: string;
	globalDir: string;
	logDir: string;
	toolsDir: string;
}

function runChild(
	cwd: string,
	fakeHome: string,
	childTmpDir: string,
	extraEnv: Record<string, string> = {},
): Promise<ChildFacts> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// The exact hazard: no home pin, no test-mode signal — a bare probe run
		// inherits the ambient shell environment minus these.
		delete env.PI_LENS_HOME;
		delete env.VITEST;
		delete env.PI_LENS_TEST_MODE;
		delete env.PILENS_PROBE;
		delete env.PILENS_DATA_DIR;
		env.USERPROFILE = fakeHome;
		env.HOME = fakeHome;
		// Steers `os.tmpdir()` inside the child — see the F3 note above.
		env.TEMP = childTmpDir;
		env.TMP = childTmpDir;
		env.TMPDIR = childTmpDir;
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
			const read = (label: string): string => {
				const line = stdout
					.split(/\r?\n/)
					.find((candidate) => candidate.startsWith(`${label}:`));
				if (!line) {
					throw new Error(
						`child stdout carried no ${label} line: ${stdout}\nstderr: ${stderr}`,
					);
				}
				return line.slice(label.length + 1).trim();
			};
			try {
				resolve({
					tmpdir: read("tmpdir"),
					globalDir: read("global-dir"),
					logDir: read("log-dir"),
					toolsDir: read("tools-dir"),
				});
			} catch (error) {
				reject(error as Error);
			}
		});
	});
}

/** A fresh throwaway tree plus the two directories every case needs. */
function makeFixture(slug: string): {
	root: string;
	fakeHome: string;
	/** A temp dir for the child that contains NOTHING else in the fixture. */
	isolatedTmp: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-${slug}-`));
	const fakeHome = path.join(root, "fake-real-home");
	const isolatedTmp = path.join(root, "child-tmp");
	fs.mkdirSync(fakeHome, { recursive: true });
	fs.mkdirSync(isolatedTmp, { recursive: true });
	return { root, fakeHome, isolatedTmp };
}

/**
 * The anti-vacuity guard for the two branches that must NOT be reachable via
 * the tmpdir branch. `isolatedTmp` is a sibling of the fixture cwd, so a cwd
 * under it would mean the case proves nothing about its own branch.
 */
function expectCwdOutsideChildTmpdir(facts: ChildFacts, cwd: string): void {
	const normalizedTmp = path.resolve(facts.tmpdir);
	expect(path.resolve(cwd).startsWith(normalizedTmp + path.sep)).toBe(false);
	expect(path.resolve(cwd)).not.toBe(normalizedTmp);
}

describe("getGlobalPiLensLogDir probe-home redirect (#2506)", () => {
	it("redirects a worktree probe's LOGS while leaving tools/registry on the real home", async () => {
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-worktree");
		// Deliberately NESTED below the worktree: the probe home must anchor at
		// the worktree itself, not at whatever directory the probe happened to
		// run from (F5). A per-cwd anchor would scatter one worktree's probe
		// logs across a directory per subfolder.
		const worktree = path.join(root, ".claude", "worktrees", "agent-x");
		const probeCwd = path.join(worktree, "clients");
		fs.mkdirSync(probeCwd, { recursive: true });

		try {
			const facts = await runChild(probeCwd, fakeHome, isolatedTmp);
			// The tmpdir branch cannot be what satisfied this case.
			expectCwdOutsideChildTmpdir(facts, probeCwd);

			// The log root moved — and anchored at the WORKTREE, not at `cwd`.
			expect(facts.logDir).toBe(path.join(worktree, ".pi-lens-probe-home"));

			// ...while every machine-global path stayed on the (fake) real home.
			// This is the whole point of the round-3 split: a pi session running
			// from a worktree must still find the tools it installed and the one
			// instances.json every other process on the box reads.
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(facts.toolsDir).toBe(path.join(fakeHome, ".pi-lens", "tools"));

			// The degradation row actually landed under the redirected log dir.
			const probeLatencyLog = path.join(facts.logDir, "latency.log");
			expect(fs.existsSync(probeLatencyLog)).toBe(true);
			const body = fs.readFileSync(probeLatencyLog, "utf8");
			expect(body).toContain("config-ignored");
			expect(body).toContain("/p/.pi-lens.json");

			// The real-home canary was never created — pre-fix, the row went here.
			expect(fs.existsSync(path.join(fakeHome, ".pi-lens", "latency.log"))).toBe(
				false,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("redirects a probe whose cwd is under os.tmpdir() with no worktree segment", async () => {
		const { root, fakeHome } = makeFixture("probe-tmpdir");
		// No `.claude/worktrees` anywhere in this path and no PILENS_PROBE: the
		// tmpdir branch is the ONLY thing that can fire here.
		const probeCwd = path.join(root, "scratch-probe");
		fs.mkdirSync(probeCwd, { recursive: true });

		try {
			// The child's os.tmpdir() IS the fixture root, so cwd sits under it.
			const facts = await runChild(probeCwd, fakeHome, root);
			expect(path.resolve(probeCwd).startsWith(path.resolve(facts.tmpdir))).toBe(
				true,
			);
			expect(probeCwd).not.toContain(".claude");

			expect(facts.logDir).toBe(path.join(probeCwd, ".pi-lens-probe-home"));
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(facts.toolsDir).toBe(path.join(fakeHome, ".pi-lens", "tools"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("PILENS_PROBE=1 forces the redirect from an ordinary checkout neither branch would catch", async () => {
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-force");
		// Neither under `.claude/worktrees/` nor under the child's os.tmpdir():
		// only the explicit force can fire here.
		const ordinaryCwd = path.join(root, "ordinary-project");
		fs.mkdirSync(ordinaryCwd, { recursive: true });

		try {
			const facts = await runChild(ordinaryCwd, fakeHome, isolatedTmp, {
				PILENS_PROBE: "1",
			});
			expectCwdOutsideChildTmpdir(facts, ordinaryCwd);
			expect(ordinaryCwd).not.toContain(".claude");

			expect(facts.logDir).toBe(path.join(ordinaryCwd, ".pi-lens-probe-home"));
			expect(facts.globalDir).toBe(path.join(fakeHome, ".pi-lens"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("leaves an ordinary checkout alone when nothing marks it as a probe", async () => {
		// The negative case. Without it, an unconditional redirect — the
		// simplest possible over-fix — would pass every other test in this file.
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-none");
		const ordinaryCwd = path.join(root, "ordinary-project");
		fs.mkdirSync(ordinaryCwd, { recursive: true });

		try {
			const facts = await runChild(ordinaryCwd, fakeHome, isolatedTmp);
			expectCwdOutsideChildTmpdir(facts, ordinaryCwd);

			const realHome = path.join(fakeHome, ".pi-lens");
			expect(facts.logDir).toBe(realHome);
			expect(facts.globalDir).toBe(realHome);
			expect(fs.existsSync(path.join(ordinaryCwd, ".pi-lens-probe-home"))).toBe(
				false,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("never claims the SHARED .claude/worktrees parent as a probe home", async () => {
		// F5, the cross-agent collision. Round 2's trailing `(\/|$)` alternative
		// matched a cwd of `.claude/worktrees` itself, so a probe run from there
		// would have put its probe home in the directory EVERY concurrent agent
		// on the box shares. The redirect must require a specific worktree.
		const { root, fakeHome, isolatedTmp } = makeFixture("probe-shared-parent");
		const sharedParent = path.join(root, ".claude", "worktrees");
		fs.mkdirSync(sharedParent, { recursive: true });

		try {
			const facts = await runChild(sharedParent, fakeHome, isolatedTmp);
			expectCwdOutsideChildTmpdir(facts, sharedParent);

			expect(facts.logDir).toBe(path.join(fakeHome, ".pi-lens"));
			expect(
				fs.existsSync(path.join(sharedParent, ".pi-lens-probe-home")),
			).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);
});

describe("probe-home resolution is memoized per process (#2506 F5)", () => {
	const savedHome = process.env.PI_LENS_HOME;
	const savedProbe = process.env.PILENS_PROBE;
	const savedCwd = process.cwd();

	afterEach(() => {
		process.chdir(savedCwd);
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedProbe === undefined) delete process.env.PILENS_PROBE;
		else process.env.PILENS_PROBE = savedProbe;
		_resetProbeHomeRedirectStateForTests();
	});

	it("resolves once and holds that answer across a process.chdir()", () => {
		// Round 2 read `process.cwd()` live on every call, so one process could
		// scatter its logs across three roots as it chdir'd. The resolution is
		// a property of the PROCESS, decided once.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-memo-"));
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		fs.mkdirSync(first, { recursive: true });
		fs.mkdirSync(second, { recursive: true });

		try {
			delete process.env.PI_LENS_HOME;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();

			process.chdir(first);
			const before = getGlobalPiLensLogDir();
			expect(before).toBe(path.join(fs.realpathSync(first), ".pi-lens-probe-home"));

			process.chdir(second);
			// Same answer despite a different cwd: memoized, not re-derived.
			expect(getGlobalPiLensLogDir()).toBe(before);

			// ...and the reset really does clear the memo, so the helper is not
			// a no-op the way round 2's orphaned version was (F6).
			_resetProbeHomeRedirectStateForTests();
			expect(getGlobalPiLensLogDir()).toBe(
				path.join(fs.realpathSync(second), ".pi-lens-probe-home"),
			);
		} finally {
			process.chdir(savedCwd);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("an explicit PI_LENS_HOME pin still wins over the redirect", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-pin-"));
		try {
			process.env.PI_LENS_HOME = root;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();
			// Both resolvers honour the pin — this is how vitest stays hermetic.
			expect(getGlobalPiLensLogDir()).toBe(path.resolve(root));
			expect(getGlobalPiLensDir()).toBe(path.resolve(root));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the probe home is gitignored (#2506 F2)", () => {
	it("git check-ignore accepts a file under .pi-lens-probe-home/", () => {
		// Without this entry every agent worktree that ever ran one probe is
		// dirty forever, and #2435's aged worktree sweep — which only removes
		// CLEAN worktrees — can never reap it.
		const probed = execFileSync(
			"git",
			["check-ignore", "-v", ".pi-lens-probe-home/latency.log"],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(probed).toContain(".pi-lens-probe-home/");
	});

	it("the ignore rule is anchored to the directory, not a loose glob", () => {
		const gitignore = fs.readFileSync(
			path.join(REPO_ROOT, ".gitignore"),
			"utf8",
		);
		expect(gitignore).toContain(".pi-lens-probe-home/");
	});
});

describe("the shared globalThis slot has exactly one key (#2506)", () => {
	// file-utils.ts cannot IMPORT probe-home-state.ts — log-cleanup.ts reaches
	// the resolver through the pre-existing cycle while file-utils.ts is still
	// mid-init, and an import binding is uninitialized in that window (this
	// issue hit that ReferenceError twice). The two modules therefore each name
	// the key as a literal. That duplication is safe only while they are
	// IDENTICAL: two different literals would give the writer and the reader
	// two silent slots, and the ledger would never see a redirect that happened.
	it("file-utils.ts writes the same literal probe-home-state.ts reads", () => {
		const fileUtils = fs.readFileSync(
			path.join(REPO_ROOT, "clients/file-utils.ts"),
			"utf8",
		);
		expect(fileUtils).toContain(`Symbol.for("${PROBE_HOME_RESOLUTION_KEY}")`);
		// ...and file-utils.ts really does NOT import the leaf, which is the
		// constraint forcing the duplication in the first place.
		expect(fileUtils).not.toMatch(/^import .*probe-home-state/m);
	});

	it("a redirect the resolver records is visible through the leaf's reader", () => {
		// The write side and the read side agreeing end to end, in one process.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-slot-"));
		const savedHome = process.env.PI_LENS_HOME;
		const savedProbe = process.env.PILENS_PROBE;
		const savedCwd = process.cwd();
		try {
			delete process.env.PI_LENS_HOME;
			process.env.PILENS_PROBE = "1";
			_resetProbeHomeRedirectStateForTests();
			process.chdir(root);

			const resolved = getGlobalPiLensLogDir();
			const stored = getProbeHomeResolution();
			expect(stored?.probeHome).toBe(resolved);
			expect(stored?.event?.probeHome).toBe(resolved);
			expect(stored?.event?.cwd).toBe(process.cwd());
		} finally {
			process.chdir(savedCwd);
			if (savedHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = savedHome;
			if (savedProbe === undefined) delete process.env.PILENS_PROBE;
			else process.env.PILENS_PROBE = savedProbe;
			_resetProbeHomeRedirectStateForTests();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
