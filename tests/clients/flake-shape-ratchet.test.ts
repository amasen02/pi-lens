/**
 * Flake-shape ratchet — #2547.
 *
 * Three deflake PRs in two days (#2531 alone fixed three shared-slot races)
 * and nothing counted the contention surface those PRs kept fixing, so the
 * set only grew. This ratchet counts it: `tests/support/flake-shape-scan.ts`
 * runs three detectors over every `tests/**\/*.test.ts` file —
 *
 * 1. `real-process-spawn` — a real child process (`child_process` import,
 *    `execFileSync`/`spawnSync`/`execSync`, or a spawn whose argv mentions
 *    `vitest`).
 * 2. `elapsed-time-assertion` — a DELTA of two clock reads flowing into a
 *    numeric matcher (`toBeLessThan`/`toBeGreaterThan`/…).
 * 3. `raw-timer-wait` — a raw `setTimeout`/`setInterval` wait outside a
 *    `vi.useFakeTimers()` scope.
 *
 * `FLAKE_SHAPE_BASELINE` (`tests/support/flake-shape-baseline.json`) is
 * today's population, content-keyed as `file → count` per detector — the
 * burn-down floor, not a target. The ratchet fails on:
 *
 * - a NEW file the scan flags that the baseline does not name, in any
 *   detector;
 * - an allowlisted file whose count in a detector RISES above its pinned
 *   value.
 *
 * A count that FALLS is not a failure — improving a file is never penalized,
 * though the baseline is left un-tightened until someone edits it (the same
 * asymmetry `sweep-kit.ts`'s `auditRegistry` chooses for stale exemptions,
 * one layer up: this ratchet's "problem" direction is only ever "something
 * got worse").
 *
 * Admission of a genuinely NEW entry (a new file, or a risen count in an
 * existing one) is a two-part gate, both required: the file carries a
 * `// flake-shape: <detector> — <reason>` header naming why a mock is not
 * faithful, AND the file is listed in `vitest.config.ts`'s
 * `wallClockBudgetInclude` project (so it runs in the fully serialized
 * lane). `ADMITTED_AFTER_BASELINE` below is the running list of entries
 * admitted this way since the baseline was minted — empty today, the same
 * empty-in-steady-state shape as `single-flight-ratchet.test.ts`'s
 * `FORWARD_DECLARED`.
 *
 * #1767's `tests/clients/runtime-session.test.ts` (a real recurring flake,
 * fixed with `vi.waitFor` timeouts and a wider `describe`/`it` budget, not a
 * raw clock delta, a raw timer, or a spawn) was checked by hand against all
 * three detectors while writing this ratchet and matches NONE of them — it
 * is the #1767 vi.waitFor/testTimeout contention-budget flake shape, a real
 * but DIFFERENT shape than the three this ratchet counts, so it correctly
 * does not appear in the baseline. Recorded here rather than silently
 * absent, so a future reader does not conclude the file was missed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import vitestConfig from "../../vitest.config.ts";
import {
	admissionHeader,
	countsByDetector,
	type DetectorName,
	DETECTOR_NAMES,
	DETECTORS,
	repoRoot,
	scanElapsedTimeAssertion,
	scanRawTimerWait,
	scanRealProcessSpawn,
} from "../support/flake-shape-scan.js";

// ── The baseline ─────────────────────────────────────────────────────────

type Baseline = Record<DetectorName, Record<string, number>>;

const FLAKE_SHAPE_BASELINE: Baseline = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "tests/support/flake-shape-baseline.json"),
		"utf8",
	),
);

/**
 * Entries admitted to a detector's baseline AFTER it was minted — a merge-
 * window device, same shape and same cost profile as
 * `single-flight-ratchet.test.ts`'s `FORWARD_DECLARED`. Empty in steady
 * state, empty right now.
 */
const ADMITTED_AFTER_BASELINE: Readonly<
	Record<string, { detector: DetectorName; reason: string }>
> = {};

/** The `wallClockBudgetInclude` project's `include` list, read from the live config — not a hand-copied mirror of it (single-source-of-truth). */
function wallClockBudgetInclude(): string[] {
	const projects: unknown = (vitestConfig as { test?: { projects?: unknown } })
		.test?.projects;
	if (!Array.isArray(projects)) {
		throw new Error(
			"vitest.config.ts default export has no test.projects array",
		);
	}
	const project = projects
		.map(
			(entry) =>
				(entry as { test?: { name?: unknown; include?: unknown } })?.test,
		)
		.find((test) => test?.name === "wall-clock-budget");
	if (!project) {
		throw new Error(
			'vitest.config.ts has no project named "wall-clock-budget"',
		);
	}
	const include = project.include;
	if (!Array.isArray(include)) {
		throw new Error('"wall-clock-budget" project has no include list');
	}
	return include.map(String);
}

interface RatchetProblem {
	file: string;
	detector: DetectorName;
	kind: "new-file" | "count-risen";
	before?: number;
	after: number;
}

/**
 * Compare today's live counts against the pinned baseline for one detector.
 * Only two directions are problems: a file the baseline has never seen, and
 * an allowlisted file whose count exceeds its pin. A file that drops out
 * entirely, or whose count falls, is fine as-is.
 */
function auditAgainstBaseline(
	detector: DetectorName,
	live: Readonly<Record<string, number>>,
): RatchetProblem[] {
	const pinned = FLAKE_SHAPE_BASELINE[detector] ?? {};
	const problems: RatchetProblem[] = [];
	for (const [file, count] of Object.entries(live)) {
		const before = pinned[file];
		if (before === undefined) {
			problems.push({ file, detector, kind: "new-file", after: count });
		} else if (count > before) {
			problems.push({
				file,
				detector,
				kind: "count-risen",
				before,
				after: count,
			});
		}
	}
	return problems;
}

function describeProblem(p: RatchetProblem): string {
	const admitted = ADMITTED_AFTER_BASELINE[`${p.detector}:${p.file}`];
	const admittedNote = admitted
		? ` (admitted: ${admitted.reason})`
		: " — admit it with a `// flake-shape: <detector> — <reason>` header " +
			"and add the file to vitest.config.ts's wallClockBudgetInclude, or " +
			"remove the real spawn / wall-clock assertion / raw timer wait";
	return p.kind === "new-file"
		? `${p.detector}: NEW flagged file ${p.file} (${p.after} hit(s))${admittedNote}`
		: `${p.detector}: ${p.file} rose from ${p.before} to ${p.after} hit(s)${admittedNote}`;
}

describe("flake-shape ratchet (#2547)", () => {
	it.each(DETECTOR_NAMES)(
		"detector %s: no new files, no risen counts vs. the baseline",
		(detector) => {
			const problems = auditAgainstBaseline(
				detector,
				countsByDetector(detector),
			);
			expect(problems.map(describeProblem)).toEqual([]);
		},
	);

	it("the baseline names no file that has vanished from the live scan", () => {
		// Stated asymmetrically on purpose (see module doc): a count FALLING is
		// not a failure above, but a baseline entry for a file the scan no
		// longer touches AT ALL is dead weight worth flagging here, same as
		// `auditRegistry`'s stale-exemption check one layer up.
		const stale: string[] = [];
		for (const detector of DETECTOR_NAMES) {
			const live = countsByDetector(detector);
			for (const file of Object.keys(FLAKE_SHAPE_BASELINE[detector] ?? {})) {
				if (!(file in live)) stale.push(`${detector}:${file}`);
			}
		}
		expect(stale).toEqual([]);
	});

	it("carries the three counts in this header (informational, kept in sync)", () => {
		// Not asserted against a hardcoded number — this test's job is only to
		// prove the header comment above stays readable-and-current; the real
		// gate is the two tests above.
		for (const detector of DETECTOR_NAMES) {
			expect(FLAKE_SHAPE_BASELINE[detector]).toBeDefined();
		}
	});
});

describe("flake-shape ratchet — the compare function", () => {
	it("ATTACK: a fixture file that adds a raw setTimeout wait is a NEW flagged file — RED", () => {
		// The acceptance-criterion scenario, driven through the real detector:
		// a file the baseline has never seen, containing exactly the shape
		// detector 3 exists to catch.
		const fixtureSource = [
			'it("waits on a raw timer, never allowlisted", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 30));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait(
			"clients/never-baselined-fixture.test.ts",
			fixtureSource,
		);
		const live = { "clients/never-baselined-fixture.test.ts": hits.length };
		const problems = auditAgainstBaseline("raw-timer-wait", live);
		expect(problems.map(describeProblem)).toEqual([
			expect.stringContaining(
				"NEW flagged file clients/never-baselined-fixture.test.ts",
			),
		]);
	});

	it("does not flag a file already at its pinned count — GREEN on the allowlist", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount,
		});
		expect(problems).toEqual([]);
	});

	it("flags a pinned file whose count rose", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		)[0];
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount + 1,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0].kind).toBe("count-risen");
	});

	it("does not flag a pinned file whose count fell (improvement is not a failure)", () => {
		const [firstFile, firstCount] = Object.entries(
			FLAKE_SHAPE_BASELINE["raw-timer-wait"],
		).find(([, count]) => count > 1)!;
		const problems = auditAgainstBaseline("raw-timer-wait", {
			[firstFile]: firstCount - 1,
		});
		expect(problems).toEqual([]);
	});
});

/**
 * Both admission-gate requirements for one `ADMITTED_AFTER_BASELINE` entry:
 * the file's own `// flake-shape: <detector> — <reason>` header, AND the
 * file's membership in `vitest.config.ts`'s `wallClockBudgetInclude`
 * project. Pulled out as its own function so it is unit-testable against
 * fixtures directly — `ADMITTED_AFTER_BASELINE` is empty in steady state, so
 * a test that only iterates it (as the real ratchet does) can never prove
 * this logic is mutation-sensitive.
 */
function validateAdmission(
	key: string,
	entry: { detector: DetectorName; reason: string },
	source: string | undefined,
	wallClockBudgetIncluded: ReadonlySet<string>,
	relativeTestsPath: string,
): string[] {
	const problems: string[] = [];
	if (source === undefined) {
		return [`${key}: file does not exist`];
	}
	const header = admissionHeader(source);
	if (!header) {
		problems.push(
			`${key}: missing "// flake-shape: <detector> — <reason>" header`,
		);
	} else if (header.detector !== entry.detector) {
		problems.push(
			`${key}: header names detector "${header.detector}", expected "${entry.detector}"`,
		);
	} else if (header.reason.length < 15) {
		problems.push(`${key}: header reason too short to be real`);
	}
	if (!wallClockBudgetIncluded.has(`tests/${relativeTestsPath}`)) {
		problems.push(
			`${key}: not listed in vitest.config.ts wallClockBudgetInclude`,
		);
	}
	if (entry.reason.trim().length < 15) {
		problems.push(`${key}: ADMITTED_AFTER_BASELINE reason too short`);
	}
	return problems;
}

describe("flake-shape ratchet — admission gate", () => {
	it("ADMITTED_AFTER_BASELINE entries carry the header and wallClockBudgetInclude membership", () => {
		const included = new Set(wallClockBudgetInclude());
		const problems: string[] = [];
		for (const [key, entry] of Object.entries(ADMITTED_AFTER_BASELINE)) {
			const file = key.slice(entry.detector.length + 1);
			const absolute = path.join(repoRoot, "tests", file);
			const source = fs.existsSync(absolute)
				? fs.readFileSync(absolute, "utf8")
				: undefined;
			problems.push(...validateAdmission(key, entry, source, included, file));
		}
		expect(problems).toEqual([]);
	});

	// `ADMITTED_AFTER_BASELINE` is empty in steady state, so the test above
	// alone never proves `validateAdmission` catches anything. These fixtures
	// drive it directly, one requirement at a time.
	const GOOD_SOURCE =
		"// flake-shape: real-process-spawn — the real CLI's exit-code " +
		"contract is under test; a mock cannot reproduce it faithfully\n" +
		"execFileSync(cmd);\n";
	const GOOD_ENTRY = {
		detector: "real-process-spawn" as const,
		reason: "the real CLI's exit-code contract is under test",
	};
	const INCLUDED = new Set(["tests/clients/some-admitted-fixture.test.ts"]);

	it("ATTACK: passes when the header, detector match, and membership all hold", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/some-admitted-fixture.test.ts",
				GOOD_ENTRY,
				GOOD_SOURCE,
				INCLUDED,
				"clients/some-admitted-fixture.test.ts",
			),
		).toEqual([]);
	});

	it("ATTACK: a missing header is caught", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			"execFileSync(cmd); // no header at all\n",
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([expect.stringContaining("missing")]);
	});

	it("ATTACK: a header naming the WRONG detector is caught", () => {
		const wrongDetectorSource =
			"// flake-shape: raw-timer-wait — this reason talks about the wrong detector\n" +
			"execFileSync(cmd);\n";
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			wrongDetectorSource,
			INCLUDED,
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining('names detector "raw-timer-wait"'),
		]);
	});

	it("ATTACK: missing wallClockBudgetInclude membership is caught even with a good header", () => {
		const problems = validateAdmission(
			"real-process-spawn:clients/some-admitted-fixture.test.ts",
			GOOD_ENTRY,
			GOOD_SOURCE,
			new Set<string>(), // empty: file is not in the include list
			"clients/some-admitted-fixture.test.ts",
		);
		expect(problems).toEqual([
			expect.stringContaining("wallClockBudgetInclude"),
		]);
	});

	it("ATTACK: a nonexistent file is caught", () => {
		expect(
			validateAdmission(
				"real-process-spawn:clients/does-not-exist.test.ts",
				GOOD_ENTRY,
				undefined,
				INCLUDED,
				"clients/does-not-exist.test.ts",
			),
		).toEqual([expect.stringContaining("does not exist")]);
	});
});

// ── The scan itself — fixtures, self-tests, mutation-proof ────────────────

describe("flake-shape scan — real-process-spawn", () => {
	it("ATTACK named spelling: child_process import + execFileSync + vitest-in-argv", () => {
		const source = [
			'import { execFileSync } from "node:child_process";',
			"",
			'it("runs the suite as a child", () => {',
			'\texecFileSync("npx", ["vitest", "run", "--reporter=json"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			"execFileSync( real sync spawn",
		]);
	});

	it("ATTACK novel spelling: require() + async spawn() with a vitest bin path in argv", () => {
		const source = [
			'const { spawn } = require("child_process");',
			"",
			'it("relaunches vitest asynchronously", () => {',
			'\tspawn(process.execPath, ["node_modules/.bin/vitest", "run"]);',
			"});",
		].join("\n");
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual([
			"child_process import",
			'spawn( vitest-in-vitest (argv mentions "vitest")',
		]);
	});

	it("does not flag an async spawn() whose argv never mentions vitest", () => {
		const source = [
			'import { spawn } from "node:child_process";',
			'it("spawns something unrelated", () => {',
			'\tspawn("git", ["status"]);',
			"});",
		].join("\n");
		// The import line still counts (a real child_process import is itself
		// the shape); the plain spawn() call does not add a second hit because
		// it is neither the sync triad nor vitest-in-argv.
		const hits = scanRealProcessSpawn("fixture.test.ts", source);
		expect(hits.map((h) => h.reason)).toEqual(["child_process import"]);
	});

	it("does not flag a comment that merely names the calls", () => {
		const source = [
			"// This test used to call execFileSync(cmd) directly.",
			'it("no longer spawns", () => {',
			"\texpect(1).toBe(1);",
			"});",
		].join("\n");
		expect(scanRealProcessSpawn("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — elapsed-time-assertion", () => {
	it("ATTACK named spelling: Date.now() delta via a variable, toBeLessThan", () => {
		const source = [
			'it("finishes fast", () => {',
			"\tconst start = Date.now();",
			"\tdoWork();",
			"\tconst elapsed = Date.now() - start;",
			"\texpect(elapsed).toBeLessThan(500);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("ATTACK novel spelling: inline performance.now() delta, toBeGreaterThanOrEqual", () => {
		const source = [
			'it("takes at least this long", () => {',
			"\tconst t0 = performance.now();",
			"\tdoSlowWork();",
			"\texpect(performance.now() - t0).toBeGreaterThanOrEqual(10);",
			"});",
		].join("\n");
		const hits = scanElapsedTimeAssertion("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(4);
	});

	it("SEMANTIC not token: a clock read and a numeric matcher in the same file, unrelated, does not fire", () => {
		// shape 34: token co-occurrence of Date.now() and toBeLessThan must NOT
		// be enough — only an actual delta flowing into the matcher counts.
		const source = [
			'it("reads the clock for a log line, asserts something unrelated", () => {',
			"\tconst start = Date.now();",
			'\tlogEvent("start", start);',
			"\texpect(result.items.length).toBeLessThan(5);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});

	it("does not flag a non-clock subtraction feeding a numeric matcher", () => {
		const source = [
			'it("checks a count", () => {',
			"\tconst remaining = total - consumed;",
			"\texpect(remaining).toBeLessThan(10);",
			"});",
		].join("\n");
		expect(scanElapsedTimeAssertion("fixture.test.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — raw-timer-wait", () => {
	it("ATTACK named spelling: raw setTimeout wait via a Promise", () => {
		const source = [
			'it("waits a bit", async () => {',
			"\tawait new Promise((resolve) => setTimeout(resolve, 50));",
			"\texpect(state.ready).toBe(true);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setTimeout");
	});

	it("ATTACK novel spelling: raw setInterval poll", () => {
		const source = [
			'it("polls until ready", () => {',
			"\tconst id = setInterval(() => checkReady(), 25);",
			"\treturn stopWhenReady(id);",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].reason).toContain("setInterval");
	});

	it("does not flag a raw wait governed by vi.useFakeTimers()", () => {
		const source = [
			'it("advances fake time", () => {',
			"\tvi.useFakeTimers();",
			"\tconst p = new Promise((resolve) => setTimeout(resolve, 1000));",
			"\tvi.advanceTimersByTime(1000);",
			"\tvi.useRealTimers();",
			"\treturn p;",
			"});",
		].join("\n");
		expect(scanRawTimerWait("fixture.test.ts", source)).toEqual([]);
	});

	it("flags a raw wait AFTER vi.useRealTimers() restores real timers", () => {
		const source = [
			'it("goes back to real timers, then waits raw", async () => {',
			"\tvi.useFakeTimers();",
			"\tvi.advanceTimersByTime(0);",
			"\tvi.useRealTimers();",
			"\tawait new Promise((resolve) => setTimeout(resolve, 20));",
			"});",
		].join("\n");
		const hits = scanRawTimerWait("fixture.test.ts", source);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(5);
	});

	it("exempts interleaving-kit.ts by name", () => {
		const source =
			"export function realWait(ms) {\n\treturn new Promise((r) => setTimeout(r, ms));\n}\n";
		expect(scanRawTimerWait("interleaving-kit.ts", source)).toEqual([]);
	});
});

describe("flake-shape scan — mutation-proof self-test", () => {
	it("has exactly the three declared detectors, each catching its own canonical fixture", () => {
		const canonicalFixtures: Record<DetectorName, string> = {
			"real-process-spawn": 'execFileSync("npx", ["vitest", "run"]);\n',
			"elapsed-time-assertion":
				"const start = Date.now();\nexpect(Date.now() - start).toBeLessThan(1);\n",
			"raw-timer-wait": "setTimeout(() => {}, 10);\n",
		};
		expect(Object.keys(canonicalFixtures).sort()).toEqual(
			[...DETECTOR_NAMES].sort(),
		);
		for (const name of DETECTOR_NAMES) {
			const detector = DETECTORS[name];
			expect(detector, `detector "${name}" must exist in DETECTORS`).toBeTypeOf(
				"function",
			);
			const hits = detector("fixture.test.ts", canonicalFixtures[name]);
			expect(
				hits.length,
				`detector "${name}" must flag its own canonical fixture`,
			).toBeGreaterThan(0);
		}
	});
});

describe("flake-shape scan — admission header parsing", () => {
	it("parses a well-formed header", () => {
		const source =
			"// flake-shape: real-process-spawn — the real npm CLI's exit-code " +
			"contract is the thing under test; a mock cannot reproduce it\n" +
			"execFileSync(cmd);\n";
		const header = admissionHeader(source);
		expect(header?.detector).toBe("real-process-spawn");
		expect(header?.reason).toContain("exit-code");
	});

	it("returns undefined with no header", () => {
		expect(admissionHeader("execFileSync(cmd);\n")).toBeUndefined();
	});
});
