import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Only the resolveExec matrix below (#1098) needs this mocked; every other
// test in this file never reaches a `findGlobalBinary` call.
const findGlobalBinary = vi.fn<(command: string) => Promise<string | undefined>>();
vi.mock("../../clients/package-manager.js", () => ({
	findGlobalBinary: (command: string) => findGlobalBinary(command),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("test-runner-client", () => {
	it("does not infer vitest from vite config alone", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "vite.config.ts"), "export default {}\n");
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "tmp", version: "1.0.0" }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("vitest");
	});

	it("parses cargo summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
			"",
			0,
			"/tmp/test.rs",
			"cargo",
		);

		expect(result.passed).toBe(3);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("parses rspec summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"3 examples, 1 failure",
			"",
			1,
			"/tmp/spec/foo_spec.rb",
			"rspec",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
	});

	// #1479: the agent-facing surface reads the same "was this measured"
	// predicate the turn-end log reads, so the two cannot drift.
	describe("formatResult duration suffix (#1479)", () => {
		const format = (duration: number) =>
			new TestRunnerClient(false).formatResult({
				file: "/tmp/foo.test.ts",
				sourceFile: "",
				runner: "vitest",
				passed: 2,
				failed: 0,
				skipped: 0,
				failures: [],
				duration,
			});

		it("prints the suffix for a measured run", () => {
			expect(format(1230)).toContain(" (1.23s)");
		});

		it("omits the suffix for an unmeasured run", () => {
			expect(format(0)).not.toContain("(");
		});

		it("omits the suffix for a non-finite duration rather than printing it", () => {
			expect(format(Number.POSITIVE_INFINITY)).not.toContain("(");
			expect(format(Number.NaN)).not.toContain("(");
		});
	});

	// #1480: `parseGenericRunnerOutput` hardcoded duration 0 for every runner
	// but go, so the turn-end log printed a constant that looked like a
	// measurement. Durations are pinned to EXACT values here: a `> 0` assertion
	// would accept the next plausible constant, which is how this defect class
	// survived #1452's sweep in the first place.
	describe("generic runner durations (#1480)", () => {
		const parse = (output: string, runner: string, exitCode = 0) =>
			(new TestRunnerClient(false) as any).parseGenericRunnerOutput(
				output,
				"",
				exitCode,
				`/tmp/test.${runner}`,
				runner,
			);

		// Format from the libtest printer shipped with the local rustc 1.94.1
		// (`formatters/pretty.rs` + `time.rs`), NOT a live `cargo test` — this
		// box has no MSVC linker, so cargo cannot link a test binary.
		it("parses the cargo test-result summary duration", () => {
			const result = parse(
				[
					"running 3 tests",
					"test tests::ok1 ... ok",
					"test tests::ign ... ignored",
					"",
					"test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.25s",
					"",
				].join("\n"),
				"cargo",
			);

			expect(result.passed).toBe(2);
			expect(result.skipped).toBe(1);
			expect(result.duration).toBe(250);
		});

		it("ignores a cargo panic message that mimics the summary suffix", () => {
			// First-match hazard: the assertion diff below carries the same
			// "; finished in ..." text the summary does. The pattern is anchored
			// to the start of the `test result:` line so the diff cannot win.
			const result = parse(
				[
					"thread 'tests::bad' panicked at src/lib.rs:9:",
					'  left: "; finished in 99.9s"',
					"",
					"test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.50s",
				].join("\n"),
				"cargo",
				101,
			);

			expect(result.duration).toBe(500);
		});

		it("leaves cargo unmeasured when the summary carries no elapsed time", () => {
			// Older rustc omits the suffix entirely.
			const result = parse(
				"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
				"cargo",
			);

			expect(result.passed).toBe(2);
			expect(result.duration).toBe(0);
		});

		// Format from the vstest.console.dll shipped with the local .NET SDK
		// 8.0.423 (summary literal plus the " h"/" m"/" s"/" ms"/"< 1 ms" unit
		// literals), NOT a live `dotnet test` — NuGet restore has no network.
		it("parses the dotnet/vstest summary duration in ms", () => {
			const result = parse(
				"Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 250 ms - t.dll (net8.0)",
				"dotnet",
				1,
			);

			expect(result.failed).toBe(1);
			expect(result.passed).toBe(2);
			expect(result.duration).toBe(250);
		});

		it("sums the dotnet/vstest multi-unit duration token list", () => {
			// vstest joins unit tokens with spaces rather than printing one
			// number, so "1 m 30 s" is 90s and "2 s 345 ms" is 2345ms.
			const minutes = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 m 30 s - t.dll (net8.0)",
				"dotnet",
			);
			const seconds = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 2 s 345 ms - t.dll (net8.0)",
				"dotnet",
			);
			const hours = parse(
				"Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 1 h 2 m - t.dll (net8.0)",
				"dotnet",
			);

			expect(minutes.duration).toBe(90_000);
			expect(seconds.duration).toBe(2345);
			expect(hours.duration).toBe(3_720_000);
		});

		it("leaves dotnet unmeasured when vstest reports sub-millisecond", () => {
			// "< 1 ms" carries no number to report. Claiming 0 would be a
			// measurement; leaving it unmeasured is the honest record.
			const result = parse(
				"Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: < 1 ms - t.dll (net8.0)",
				"dotnet",
			);

			expect(result.passed).toBe(1);
			expect(result.duration).toBe(0);
		});

		// Surefire format from its console reporter, NOT a live maven run —
		// there is no mvn on this box.
		it("sums the maven/surefire per-class Time elapsed lines", () => {
			const result = parse(
				[
					"[INFO] Running com.example.AppTest",
					"[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s -- in com.example.AppTest",
					"[INFO] Running com.example.OtherTest",
					"[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.125 s -- in com.example.OtherTest",
					"[INFO] Results:",
					"[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
					"[INFO] Total time:  9.876 s",
				].join("\n"),
				"maven",
				1,
			);

			// 50 + 125. NOT 9876: "[INFO] Total time" is whole-build wall clock
			// including compile, and reporting it as test time would be a wrong
			// number rather than an absent one.
			expect(result.duration).toBe(175);
			expect(result.failed).toBe(1);
		});

		it("scores a multi-class maven run by the aggregate, not the first class", () => {
			// Adjacent first-match defect the duration fixture exposed: surefire
			// prints a `Tests run:` line per class, so reading the FIRST one
			// reported the second class's failure as a pass.
			const result = parse(
				[
					"[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s -- in com.example.AppTest",
					"[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.125 s -- in com.example.OtherTest",
					"[INFO] Results:",
					"[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
				].join("\n"),
				"maven",
				1,
			);

			expect(result.failed).toBe(1);
			expect(result.passed).toBe(3);
		});

		it("accepts the surefire 2.x 'sec' spelling", () => {
			const result = parse(
				"Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.012 sec - in com.example.AppTest",
				"maven",
			);

			expect(result.duration).toBe(12);
		});

		// REAL capture: rspec-core 3.13.6 on ruby 3.4.10.
		it("parses the rspec Finished-in line", () => {
			const result = parse(
				[
					".F",
					"",
					"Finished in 0.32394 seconds (files took 0.49427 seconds to load)",
					"2 examples, 1 failure",
				].join("\n"),
				"rspec",
				1,
			);

			expect(result.passed).toBe(1);
			expect(result.failed).toBe(1);
			// 323.94ms, NOT the 494.27ms file-load time that trails it on the
			// same line.
			expect(result.duration).toBe(324);
		});

		it("parses the rspec minutes form", () => {
			// From RSpec::Core::Formatters::Helpers.format_duration in the
			// installed gem: past 60s it prints "N minutes M.MM seconds".
			const result = parse(
				[
					"Finished in 2 minutes 15.14 seconds (files took 0.5 seconds to load)",
					"2 examples, 0 failures",
				].join("\n"),
				"rspec",
			);

			expect(result.duration).toBe(135_140);
		});

		it("ignores an rspec failure diff that mimics the Finished-in line", () => {
			// First-match hazard: the quoted expectation below would win an
			// unanchored /m match. The pattern requires the line to START with
			// "Finished in", which rspec's own summary does and a diff does not.
			const result = parse(
				[
					"Failures:",
					"",
					"  1) demo fails",
					"     Failure/Error: expect(log).to eq 'Finished in 99 seconds'",
					"",
					"Finished in 0.32394 seconds (files took 0.49427 seconds to load)",
					"2 examples, 1 failure",
				].join("\n"),
				"rspec",
				1,
			);

			expect(result.duration).toBe(324);
		});

		// REAL capture: minitest 5.25.4 on ruby 3.4.10.
		it("parses the minitest Finished-in line", () => {
			const result = parse(
				[
					"Run options: --seed 63795",
					"",
					"F.",
					"",
					"Finished in 0.254594s, 7.8557 runs/s, 7.8557 assertions/s.",
					"",
					"2 runs, 2 assertions, 1 failures, 0 errors, 0 skips",
				].join("\n"),
				"minitest",
				1,
			);

			expect(result.passed).toBe(1);
			expect(result.failed).toBe(1);
			expect(result.duration).toBe(255);
		});

		// Gradle's console summary carries no elapsed time and "BUILD
		// SUCCESSFUL in 3s" is whole-build wall clock, so this stays unmeasured
		// on purpose. #1479 makes that absence legible in the log.
		it("leaves gradle unmeasured rather than borrowing the build time", () => {
			const result = parse(
				[
					"> Task :test FAILED",
					"4 tests completed, 1 failed",
					"BUILD FAILED in 3s",
				].join("\n"),
				"gradle",
				1,
			);

			expect(result.failed).toBe(1);
			expect(result.passed).toBe(3);
			expect(result.duration).toBe(0);
		});

		it("still parses the go package summary duration", () => {
			const result = parse(
				"ok  \texample.com/pkg\t0.253s\n",
				"go",
			);

			expect(result.duration).toBe(253);
		});

		it("leaves an unrecognised runner summary unmeasured", () => {
			const result = parse("everything is fine\n", "somethingelse");

			expect(result.duration).toBe(0);
		});
	});

	it("prefers failed-first target when failure cache exists", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
		const src = path.join(tmpDir, "sum.go");
		const testFile = path.join(tmpDir, "sum_test.go");
		fs.writeFileSync(src, "package main\n");
		fs.writeFileSync(testFile, "package main\n");

		const client = new TestRunnerClient(false) as any;
		client.failedTestsByRunner.set(`${path.resolve(tmpDir)}:go`, new Set([testFile]));

		const target = client.getTestRunTarget(src, tmpDir);
		expect(target?.strategy).toBe("failed-first");
		expect(target?.testFile).toBe(path.resolve(testFile));
	});

	it("does not infer pytest from pyproject without pytest section", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[project]\nname='demo'\nversion='0.1.0'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected?.runner).not.toBe("pytest");
	});

	it("infers pytest when pyproject has pytest.ini_options", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[tool.pytest.ini_options]\naddopts='-q'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "main.py"));
		expect(detected?.runner).toBe("pytest");
	});

	it("does not use global pytest fallback for non-Python files", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected).toBeNull();
	});

	describe("findTestFile — mirrored test-tree layout (#547)", () => {
		it("finds a TS test mirrored under tests/<subdir>/, matching this repo's own layout", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "knip-client.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "knip-client.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a mirrored test under __tests__/<subdir>/", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "lib", "utils");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "format.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "__tests__", "lib", "utils");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "format.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a Python test mirrored under tests/<subdir>/ (test_*.py)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg", "sub");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const testDir = path.join(tmpDir, "tests", "pkg", "sub");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a colocated test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(srcDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a flat top-level tests/ test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "gadget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "gadget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("prefers same-directory test over mirrored tests/ when both exist", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "dual.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const colocated = path.join(srcDir, "dual.test.ts");
			fs.writeFileSync(colocated, "// colocated\n");

			const mirroredDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(mirroredDir, { recursive: true });
			fs.writeFileSync(path.join(mirroredDir, "dual.test.ts"), "// mirrored\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(colocated);
		});
	});

	describe("detectRunner — hoisted monorepo node_modules", () => {
		it("finds vitest hoisted to the workspace root from a nested package cwd", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			// Simulate npm/yarn/pnpm workspace hoisting: vitest only lives in
			// node_modules at the workspace root, not in the package's own
			// node_modules (which may not even exist).
			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "foo");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "foo", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("vitest");
		});

		it("finds jest hoisted two levels up (scoped package nesting)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "jest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "@scope", "bar");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "@scope/bar", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("jest");
		});

		it("does not walk up past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			// Nest the cwd deeper than MAX_NODE_MODULES_WALK_UP (5) so the
			// hoisted node_modules at tmpDir is out of range.
			const deepDir = path.join(tmpDir, "a", "b", "c", "d", "e", "f", "g");
			fs.mkdirSync(deepDir, { recursive: true });
			fs.writeFileSync(
				path.join(deepDir, "package.json"),
				JSON.stringify({ name: "deep", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(deepDir);
			expect(detected).toBeNull();
		});
	});

	describe("findTestFile — bounded recursive Python test discovery", () => {
		it("finds a test file grouped by kind (tests/unit/) rather than mirrored", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Grouped-by-kind layout: tests/unit/test_foo.py, not the mirrored
			// tests/pkg/test_foo.py the exact-match candidates would look for.
			const testDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("does not recurse past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Nest the test file deeper than MAX_PYTEST_RECURSE_DEPTH (3)
			// below tests/, so the bounded recursive search must not find it.
			const testDir = path.join(tmpDir, "tests", "a", "b", "c", "d");
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(
				path.join(testDir, "test_foo.py"),
				"def test_x(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found).toBeNull();
		});

		it("still prefers the mirrored subdir match over the recursive fallback", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const mirroredDir = path.join(tmpDir, "tests", "pkg");
			fs.mkdirSync(mirroredDir, { recursive: true });
			const mirroredTest = path.join(mirroredDir, "test_foo.py");
			fs.writeFileSync(mirroredTest, "def test_mirrored(): pass\n");

			const groupedDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(groupedDir, { recursive: true });
			fs.writeFileSync(
				path.join(groupedDir, "test_foo.py"),
				"def test_grouped(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(mirroredTest);
		});
	});

	describe("getTestRunTarget — editing a test file directly (#547 follow-up)", () => {
		it("returns a .test.ts file itself as the target, not a discovered nonsense file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "foo.test.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a .spec.ts file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "bar.spec.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a Python test_foo.py file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const src = path.join(tmpDir, "test_foo.py");
			fs.writeFileSync(src, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("still uses findTestFile discovery for a normal (non-test) source file — no regression", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(tmpDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(testFile));
			expect(target?.strategy).toBe("related");
		});

		it("prefers failed-first over self when the edited test file is itself in the failed set", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "flaky.test.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false) as any;
			client.failedTestsByRunner.set(
				`${path.resolve(tmpDir)}:vitest`,
				new Set([path.resolve(src)]),
			);

			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("failed-first");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	describe("parseVitestTestGlobs — best-effort vitest config scrape", () => {
		it("extracts include/exclude string-literal arrays from a simple config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.check.ts', \"e2e/**/*.flow.ts\"],",
					"    exclude: ['src/legacy/**'],",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			const globs = client.parseVitestTestGlobs(tmpDir);
			expect(globs?.include).toEqual(["src/**/*.check.ts", "e2e/**/*.flow.ts"]);
			expect(globs?.exclude).toEqual(["src/legacy/**"]);
		});

		it("returns null when there is no vitest config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("returns null when include/exclude is built dynamically (unparseable)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: computeIncludes(),",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("caches the parsed result — does not re-read the config file on repeated calls", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const configPath = path.join(tmpDir, "vitest.config.ts");
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['a.ts'] } };\n",
			);

			const client = new TestRunnerClient(false);
			const first = client.parseVitestTestGlobs(tmpDir);
			expect(first?.include).toEqual(["a.ts"]);

			// Rewrite the config with a different include array. If the result
			// were re-read/re-parsed on the next call, this would change the
			// returned globs — the cache must keep returning the first result.
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['b.ts', 'c.ts'] } };\n",
			);
			const second = client.parseVitestTestGlobs(tmpDir);
			expect(second?.include).toEqual(["a.ts"]);
			expect(second).toBe(first);
		});

		it("uses a custom include glob to correct classification of an unconventionally-named test file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.check.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "widget.check.ts");
			fs.writeFileSync(src, "// unconventional test naming\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});

		// #628 pin: a broad `include` glob (any `.ts` file under `src/`) must NOT
		// alone classify a plain source file as its own test target. This is the
		// exact shape of the real dogfooding bug — background-review.ts / index.ts
		// got treated as strategy "self" and vitest reported a vacuous
		// `PASS 0p/0f (0ms)` because the project's include glob happened to match
		// every .ts file, not just test files.
		it("does NOT classify a plain source file as self-test from a broad include glob alone (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "src"));
			const src = path.join(tmpDir, "src", "background-review.ts");
			fs.writeFileSync(src, "export function review() {}\n");
			// No companion test file exists — this file has nothing to run.

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
			expect(target).toBeNull();
		});

		// Same shape, but the broad glob is the maximally-generic `**/*.ts` (no
		// directory restriction at all) — still must not self-classify.
		it("does NOT classify a plain source file as self-test from an unrestricted **/*.ts include (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "index.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
		});

		// The legitimate case the include-override exists for: a project whose
		// tests live under a conventional `tests/` directory without `.test.` in
		// the filename. This is a narrower signal (a literal test-ish directory
		// segment) than "any file with this extension", so it must still work.
		it("still classifies a file under a bare tests/ directory glob as self-test (legitimate override, #628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['tests/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "tests"));
			const src = path.join(tmpDir, "tests", "widget.ts");
			fs.writeFileSync(src, "// lives in tests/, no .test. in the name\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	// --- PHPUnit ---

	it("detects phpunit via phpunit.xml.dist", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "phpunit.xml.dist"), "<phpunit></phpunit>\n");

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("detects phpunit via composer.json require-dev", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({
				name: "acme/demo",
				"require-dev": { "phpunit/phpunit": "^10.0" },
			}),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("does not infer phpunit from composer.json without a phpunit dependency", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({ name: "acme/demo", "require-dev": {} }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("phpunit");
	});

	it("finds the mirrored PHPUnit test file (src/Foo/Bar.php -> tests/Foo/BarTest.php)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "phpunit.xml"), "<phpunit></phpunit>\n");
		const src = createTempFile(tmpDir, "src/Foo/Bar.php", "<?php\nclass Bar {}\n");
		const testFile = createTempFile(
			tmpDir,
			"tests/Foo/BarTest.php",
			"<?php\nclass BarTest {}\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("phpunit");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing PHPUnit OK summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(12);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("parses a failing PHPUnit summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"FAILURES!",
			"",
			"1) Foo\\BarTest::testSomething",
			"Failed asserting that false is true.",
			"",
			"Tests: 12, Assertions: 34, Errors: 1, Failures: 2, Skipped: 1.",
		].join("\n");
		const result = client.parsePhpunitOutput(
			output,
			"",
			1,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(8);
		expect(result.failed).toBe(3);
		expect(result.skipped).toBe(1);
		expect(result.failures[0].name).toBe("Foo\\BarTest::testSomething");
	});

	// #1452: PHPUnit's own elapsed time was never parsed, so every PHPUnit run
	// reported 0ms. The summary line changed shape across supported majors, so
	// both are pinned. Literal lines, not a live run — there is no PHP toolchain
	// on the machine this was written on.
	it("parses the PHPUnit >= 9.3 clock Time line (MM:SS.mmm)", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nTime: 00:00.123, Memory: 8.00 MB\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(12);
		expect(result.duration).toBe(123);
	});

	it("reads a PHPUnit fractional second as tenths, not as milliseconds", () => {
		const client = new TestRunnerClient(false) as any;
		// "00:00.1" is a TENTH of a second. Parsing the fraction as an integer
		// would report 1ms for a 100ms run.
		const result = client.parsePhpunitOutput(
			"Time: 00:00.1, Memory: 8.00 MB\nOK (1 test, 1 assertion)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.duration).toBe(100);
	});

	it("parses a PHPUnit Time line carrying hours", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"Time: 01:02:03.456, Memory: 8.00 MB\nOK (1 test, 1 assertion)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.duration).toBe(3_723_456);
	});

	it("parses the legacy PHPUnit <= 9.2 Time line (seconds and ms)", () => {
		const client = new TestRunnerClient(false) as any;
		const seconds = client.parsePhpunitOutput(
			"Time: 1.23 seconds, Memory: 10.00MB\nOK (2 tests, 2 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);
		const millis = client.parsePhpunitOutput(
			"Time: 123 ms, Memory: 10.00MB\nOK (2 tests, 2 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(seconds.duration).toBe(1230);
		expect(millis.duration).toBe(123);
	});

	it("leaves the PHPUnit duration at 0 when no Time line is present", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		// An unrecognised summary must degrade to "unmeasured" — formatResult
		// suppresses the suffix on `duration > 0` — never to a wrong number.
		expect(result.duration).toBe(0);
	});

	// --- vitest / jest JSON reporter (#1452) ---
	//
	// The payloads below are trimmed captures of REAL runs of a three-test file
	// (one 120ms pass, one fail, one skip) under vitest 4.1.10 and jest 30.4.2
	// on node 24.5.0. Trimmed of `snapshot`/`failureMessages`/suite counters
	// only — every field these assertions read is verbatim, including vitest's
	// float `endTime` and jest's `duration: null` on the skipped assertion.
	//
	// Note what is NOT in either capture: `perfStats`. It lives on jest's
	// internal TestResult, not on the JSON reporter's output, so a duration fix
	// that reads it would still report 0.

	const VITEST_JSON = JSON.stringify({
		numPassedTests: 1,
		numFailedTests: 1,
		numPendingTests: 1,
		numTodoTests: 0,
		startTime: 1786866554004,
		testResults: [
			{
				name: "/tmp/vtjson/sample.test.js",
				status: "failed",
				startTime: 1786866554330,
				endTime: 1786866554461.674,
				assertionResults: [
					{ status: "passed", title: "slow pass", duration: 122.60340400000001 },
					{ status: "failed", title: "quick fail", duration: 8.674104 },
					{ status: "skipped", title: "skipped" },
				],
			},
		],
	});

	const JEST_JSON = JSON.stringify({
		numPassedTests: 1,
		numFailedTests: 1,
		numPendingTests: 1,
		numTodoTests: 0,
		startTime: 1786866618394,
		testResults: [
			{
				name: "/tmp/jestjson/sample.test.js",
				status: "failed",
				startTime: 1786866618477,
				endTime: 1786866619206,
				assertionResults: [
					{ status: "passed", title: "slow pass", duration: 124 },
					{ status: "failed", title: "quick fail", duration: 3 },
					{ status: "pending", title: "skipped", duration: null },
				],
			},
		],
	});

	it("extracts a real duration from a vitest --reporter=json payload", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			VITEST_JSON,
			"",
			"/tmp/vtjson/sample.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.passed).toBe(1);
		expect(result.failed).toBe(1);
		// 1786866554461.674 - 1786866554330, rounded. Pinned exactly rather than
		// "> 0": the whole defect was a plausible-looking constant.
		expect(result.duration).toBe(132);
	});

	it("extracts a real duration from a jest --json payload", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseJestOutput(
			JEST_JSON,
			"",
			"/tmp/jestjson/sample.test.js",
			"/tmp/jestjson",
			"jest",
		);

		expect(result.passed).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.duration).toBe(729);
	});

	it("counts a skipped test from numPendingTests, which is what both reporters emit", () => {
		const client = new TestRunnerClient(false) as any;
		const vitest = client.parseVitestOutput(
			VITEST_JSON,
			"",
			"/tmp/vtjson/sample.test.js",
			"/tmp/vtjson",
			"vitest",
		);
		const jest = client.parseJestOutput(
			JEST_JSON,
			"",
			"/tmp/jestjson/sample.test.js",
			"/tmp/jestjson",
			"jest",
		);

		// Neither payload has `numSkippedTests`, which is the field the parser
		// used to read — so this was always 0 for a file with skips in it.
		expect(vitest.skipped).toBe(1);
		expect(jest.skipped).toBe(1);
	});

	// Both captures above happen to carry `numTodoTests: 0`, so the todo half of
	// the skip count is unasserted and can be deleted without failing anything.
	// Real runs do emit it: a `test.todo` alongside a `test.skip` gives
	// numPendingTests 1 / numTodoTests 1 on vitest 4.1.10 and jest 30.4.2.
	// Synthetic rather than captured — kept minimal so it is obviously not
	// passing itself off as one of the recorded payloads above.
	it("folds numTodoTests into the same skipped figure as numPendingTests", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				numPendingTests: 1,
				numTodoTests: 2,
				testResults: [
					{
						name: "/tmp/vtjson/todo.test.js",
						status: "passed",
						startTime: 1786866554330,
						endTime: 1786866554430,
						assertionResults: [{ status: "passed", title: "p", duration: 1 }],
					},
				],
			}),
			"",
			"/tmp/vtjson/todo.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.skipped).toBe(3);
	});

	// A reporter that emits `numSkippedTests: 0` while a skip really did happen
	// must not resurrect the defect: `??` accepts a present 0, so the count has
	// to be the larger of the two readings rather than the first one found.
	it("does not let a zero numSkippedTests mask a real pending count", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				numSkippedTests: 0,
				numPendingTests: 3,
				numTodoTests: 0,
				testResults: [
					{
						name: "/tmp/vtjson/mask.test.js",
						status: "passed",
						startTime: 1786866554330,
						endTime: 1786866554430,
						assertionResults: [{ status: "passed", title: "p", duration: 1 }],
					},
				],
			}),
			"",
			"/tmp/vtjson/mask.test.js",
			"/tmp/vtjson",
			"vitest",
		);

		expect(result.skipped).toBe(3);
	});

	it("falls back to summed assertion durations when a payload carries only perfStats", () => {
		const client = new TestRunnerClient(false) as any;
		// The pre-#1452 suggestion was to read `testResults[].perfStats`. This
		// payload is that hypothetical shape: perfStats present, the per-suite
		// epoch pair absent. The fallback keeps a real figure rather than 0.
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 2,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						perfStats: { start: 1000, end: 1400, runtime: 400, slow: false },
						assertionResults: [
							{ status: "passed", title: "a", duration: 30.4 },
							{ status: "passed", title: "b", duration: 11.2 },
						],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		expect(result.duration).toBe(42);
	});

	it("reports the wall-clock span, not the sum, across parallel suites", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseJestOutput(
			JSON.stringify({
				numPassedTests: 2,
				numFailedTests: 0,
				testResults: [
					{ name: "/tmp/a.test.js", status: "passed", startTime: 1000, endTime: 1500 },
					{ name: "/tmp/b.test.js", status: "passed", startTime: 1100, endTime: 1900 },
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"jest",
		);

		// Summing the two suites would claim 1300ms of elapsed time for a run
		// that took 900ms of wall clock.
		expect(result.duration).toBe(900);
	});

	it("reports 0 rather than a negative duration when suite timestamps are inverted", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseVitestOutput(
			JSON.stringify({
				numPassedTests: 1,
				numFailedTests: 0,
				testResults: [
					{
						name: "/tmp/a.test.js",
						status: "passed",
						startTime: 2000,
						endTime: 1000,
						assertionResults: [{ status: "passed", title: "a", duration: null }],
					},
				],
			}),
			"",
			"/tmp/a.test.js",
			"/tmp",
			"vitest",
		);

		expect(result.duration).toBe(0);
	});

	// --- mix test (ExUnit) ---

	it("detects mix via mix.exs", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "mix.exs"), "defmodule Demo.MixProject do\nend\n");

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("mix");
	});

	it("finds the mirrored ExUnit test file (lib/accounts/user.ex -> test/accounts/user_test.exs)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "mix.exs"), "defmodule Demo.MixProject do\nend\n");
		const src = createTempFile(
			tmpDir,
			"lib/accounts/user.ex",
			"defmodule Demo.Accounts.User do\nend\n",
		);
		const testFile = createTempFile(
			tmpDir,
			"test/accounts/user_test.exs",
			"defmodule Demo.Accounts.UserTest do\nend\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("mix");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing mix test summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseMixTestOutput(
			"..\n\nFinished in 0.05 seconds\n2 tests, 0 failures\n",
			"",
			0,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.duration).toBeCloseTo(50, 0);
	});

	it("parses a failing mix test summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"  1) test creates a user (Demo.Accounts.UserTest)",
			"     test/accounts/user_test.exs:5",
			"     Assertion with == failed",
			"",
			"Finished in 0.08 seconds",
			"3 tests, 1 failure",
		].join("\n");
		const result = client.parseMixTestOutput(
			output,
			"",
			1,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failures[0].name).toBe("test creates a user");
		expect(result.failures[0].location).toBe("Demo.Accounts.UserTest");
	});
});

/**
 * Regression matrix for #1098: `resolveExec` used to drop
 * `config.args(testFile, cwd)[0]` UNCONDITIONALLY whenever local-bin or
 * global-bin resolution succeeded — an npx-wrapper-convention assumption
 * (arg 0 names the binary, like `npx vitest run …`) that only holds for
 * wrapper-style runners (vitest/jest/pytest). For direct runners whose
 * args() leads with a REAL subcommand (`cargo test --no-fail-fast`,
 * `go test -run . ./pkg`, `dotnet test --no-build`, `mvn test -q`,
 * `mix test <file>`), the same unconditional `.slice(1)` silently ate the
 * subcommand — e.g. `cargo test --no-fail-fast` became the argv-invalid
 * `cargo --no-fail-fast` (a clap usage error), which the runner then
 * misreported as "1/1 failed" at turn-end.
 *
 * The fix (`stripWrapperArgs` in clients/test-runner-client.ts) only drops
 * the leading arg(s) when they actually NAME the resolved binary — either
 * `[binName, ...]` (vitest/jest) or `["-m", binName, ...]` (pytest) — and
 * leaves everything else untouched.
 *
 * This asserts the invariant generically by iterating the EXPORTED
 * `RUNNERS` config table (not a hand-copied runner list), across every
 * resolution path `resolveExec` can take:
 *   - local-bin hit  (a real file dropped in node_modules/.bin, or
 *                      vendor/bin for phpunit's Composer convention)
 *   - global-bin hit (findGlobalBinary mocked to resolve)
 *   - fallback       (neither resolves; config.command is used verbatim)
 * so a future runner added to RUNNERS is automatically covered.
 *
 * The expected argv for each case is computed independently of the
 * production `stripWrapperArgs` helper (a local re-statement of the same
 * contract), so a regression that reintroduces unconditional stripping (or
 * any other over/under-stripping) fails this test rather than trivially
 * agreeing with whatever the implementation currently does.
 */
describe("resolveExec argv preservation matrix (#1098)", () => {
	const resolveCleanups: Array<() => void> = [];

	beforeEach(() => {
		findGlobalBinary.mockReset();
		findGlobalBinary.mockResolvedValue(undefined);
	});

	afterEach(() => {
		for (const c of resolveCleanups.splice(0)) c();
	});

	function expectedStrippedArgs(binName: string, args: string[]): string[] {
		if (args[0] === binName) return args.slice(1);
		if (args[0] === "-m" && args[1] === binName) return args.slice(2);
		return args;
	}

	function binSuffix(): string {
		return process.platform === "win32" ? ".cmd" : "";
	}

	for (const [runnerKey, config] of Object.entries(RUNNERS)) {
		const binName = config.binName ?? runnerKey;

		describe(`runner: ${runnerKey}`, () => {
			it("preserves argv on local-bin resolution", () => {
				const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
				resolveCleanups.push(cleanup);
				const client = new TestRunnerClient(false) as any;

				let localBinPath: string;
				if (runnerKey === "phpunit") {
					const phpSuffix = process.platform === "win32" ? ".bat" : "";
					localBinPath = path.join(tmpDir, "vendor", "bin", `phpunit${phpSuffix}`);
				} else {
					localBinPath = path.join(
						tmpDir,
						"node_modules",
						".bin",
						`${binName}${binSuffix()}`,
					);
				}
				fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
				fs.writeFileSync(localBinPath, "");

				const testFile = path.join(
					tmpDir,
					`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
				);
				const rawArgs = config.args(testFile, tmpDir);

				return client
					.resolveExec(runnerKey, config, testFile, tmpDir)
					.then((resolved: { command: string; args: string[] }) => {
						expect(resolved.command).toBe(localBinPath);
						// phpunit's local (vendor/bin) resolution never strips —
						// see the dedicated branch in resolveExec.
						const expected =
							runnerKey === "phpunit" ? rawArgs : expectedStrippedArgs(binName, rawArgs);
						expect(resolved.args).toEqual(expected);
					});
			});

			if (runnerKey !== "phpunit") {
				// phpunit has no separate global-bin resolution step — its
				// non-local branch falls straight through to the fallback
				// (`command: "phpunit"`), so it's covered by the fallback case
				// below instead of duplicated here.
				it("preserves argv on global-bin resolution", () => {
					const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
					resolveCleanups.push(cleanup);
					const client = new TestRunnerClient(false) as any;

					const globalBinPath = path.join(tmpDir, "global-bin", binName);
					findGlobalBinary.mockImplementation(async (name: string) =>
						name === binName ? globalBinPath : undefined,
					);

					const testFile = path.join(
						tmpDir,
						`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
					);
					const rawArgs = config.args(testFile, tmpDir);

					return client
						.resolveExec(runnerKey, config, testFile, tmpDir)
						.then((resolved: { command: string; args: string[] }) => {
							expect(resolved.command).toBe(globalBinPath);
							expect(resolved.args).toEqual(expectedStrippedArgs(binName, rawArgs));
						});
				});
			}

			it("preserves argv verbatim on fallback (no local/global bin)", () => {
				const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
				resolveCleanups.push(cleanup);
				const client = new TestRunnerClient(false) as any;

				const testFile = path.join(
					tmpDir,
					`sample_test${runnerKey === "go" ? ".go" : ".txt"}`,
				);
				const rawArgs = config.args(testFile, tmpDir);

				return client
					.resolveExec(runnerKey, config, testFile, tmpDir)
					.then((resolved: { command: string; args: string[] }) => {
						expect(resolved.command).toBe(
							runnerKey === "phpunit" ? "phpunit" : config.command,
						);
						// Fallback never resolves a binary to become the command, so
						// there is nothing to strip — args() is used verbatim.
						expect(resolved.args).toEqual(rawArgs);
					});
			});
		});
	}

	it("cargo's subcommand survives local-bin resolution (the reported #1098 case)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
		resolveCleanups.push(cleanup);
		const client = new TestRunnerClient(false) as any;

		const localBinPath = path.join(tmpDir, "node_modules", ".bin", `cargo${binSuffix()}`);
		fs.mkdirSync(path.dirname(localBinPath), { recursive: true });
		fs.writeFileSync(localBinPath, "");

		const testFile = path.join(tmpDir, "src", "lib.rs");

		return client
			.resolveExec("cargo", RUNNERS.cargo, testFile, tmpDir)
			.then((resolved: { command: string; args: string[] }) => {
				expect(resolved.command).toBe(localBinPath);
				// Pre-fix, this was ["--no-fail-fast"] (the "test" subcommand was
				// eaten), producing a clap usage error at spawn time.
				expect(resolved.args).toEqual(["test", "--no-fail-fast"]);
			});
	});

	it("rspec resolves the real binary name (bundle), not the runner key", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-resolve-exec-");
		resolveCleanups.push(cleanup);
		const client = new TestRunnerClient(false) as any;

		const bundleBinPath = path.join(tmpDir, "global-bin", "bundle");
		findGlobalBinary.mockImplementation(async (name: string) =>
			name === "bundle" ? bundleBinPath : undefined,
		);

		const testFile = path.join(tmpDir, "spec", "foo_spec.rb");

		return client
			.resolveExec("rspec", RUNNERS.rspec, testFile, tmpDir)
			.then((resolved: { command: string; args: string[] }) => {
				expect(resolved.command).toBe(bundleBinPath);
				// "exec" is a real bundle subcommand, not the binary name — must
				// survive intact so `bundle exec rspec <file>` reaches bundle.
				expect(resolved.args).toEqual(["exec", "rspec", testFile]);
				expect(findGlobalBinary).toHaveBeenCalledWith("bundle");
			});
	});
});
