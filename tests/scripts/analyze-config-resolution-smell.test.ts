/**
 * #2526: `npm run logs:smells` gains a "config resolution" smell.
 *
 * Two shapes, one smell id, asserted against the real script run as a
 * subprocess over a crafted log root — the same harness
 * `analyze-pi-lens-logs.test.ts` uses, kept in its own file so the shared
 * fixture's existing count assertions stay untouched:
 *
 * 1. A session that EXPECTED config resolution and produced no
 *    `config_resolved` row.
 * 2. A `config_resolved` row carrying a LEGACY document that produced zero
 *    migration records — the deprecation machinery gone silent while the user
 *    sits on a removal schedule.
 *
 * A canonical-only session with its row present must produce NO smell: silence
 * has to mean "resolved and clean", which is the whole point of the issue.
 *
 * ## Round 2, F2: a JOIN, not a subtraction
 *
 * The first round counted `Math.max(0, starts - resolved)`, subtracting
 * `config_resolved` rows from `session_start cwd:` lines. Those two facts do
 * not describe the same population. `session_start cwd:` is written on the FULL
 * path only (`runtime-session.ts` returns from quick mode well before it),
 * while a QUICK session resolves config and writes a row — so a quick
 * session's row cancelled a full session's missing one and total silence
 * summed to zero. The inverse was worse: a `--no-lsp` or subagent session
 * emits the start line and never resolves, so it contributed a PERMANENT false
 * deficit that a reader learns to ignore.
 *
 * Both disappear once each session carries an identity. `handleSessionStart`
 * publishes one `session_start config-resolution session=<id> expected=<bool>`
 * line per session — on both paths, before quick mode's early return — and the
 * `config_resolved` record carries the same id. The analyzer joins on it: a
 * session counts as unresolved only when its own start said a resolution was
 * expected and no row bearing its id exists.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/analyze-pi-lens-logs.mjs",
);

const NOW = new Date().toISOString();
const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

interface Smell {
	id: string;
	count: number;
	severity: string;
	description: string;
	examples: unknown[];
}

interface Report {
	smells: Smell[];
	config: {
		resolved: number;
		sessionsExpectingResolution: number;
		sessionsWithoutResolution: number;
		legacyDocuments: number;
		legacyWithoutRecords: number;
	};
}

function configResolvedRow(options: {
	sessionId: string;
	documents: Array<{ tier: string; file: string; legacy: boolean }>;
	recordCount: number;
}): Record<string, unknown> {
	return {
		type: "phase",
		ts: NOW,
		phase: "config_resolved",
		filePath: "/home/u/Desktop/proj",
		durationMs: 3,
		metadata: {
			sessionId: options.sessionId,
			documents: options.documents,
			countsByTier: { builtin: 0, global: 0, project: 4 },
			recordCount: options.recordCount,
			deniedServers: 0,
			resolveMs: 3,
		},
	};
}

/**
 * One session's sessionstart.log footprint.
 *
 * `full` decides whether the `session_start cwd:` line is written at all —
 * quick mode returns before it, which is precisely the asymmetry the old
 * subtraction could not see.
 */
interface SessionFixture {
	id: string;
	expected: boolean;
	/** Quick mode never reaches the `session_start cwd:` line. */
	full: boolean;
	/** Why no resolution is expected — `ok` when one is. */
	reason?: string;
}

function sessionLines(session: SessionFixture): string[] {
	const lines = [
		`[${NOW}] session_start config-resolution session=${session.id} ` +
			`expected=${session.expected} reason=${session.reason ?? "ok"}`,
	];
	if (session.full) {
		lines.push(`[${NOW}] session_start cwd: /home/u/Desktop/proj`);
	}
	return lines;
}

function buildRoot(options: {
	sessions: SessionFixture[];
	latency: Array<Record<string, unknown>>;
}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgsmell-"));
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, "latency.log"),
		`${options.latency.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	fs.writeFileSync(
		path.join(dir, "sessionstart.log"),
		`${options.sessions.flatMap(sessionLines).join("\n")}\n`,
	);
	return dir;
}

function runReport(root: string): Report {
	const out = execFileSync(
		process.execPath,
		[SCRIPT, "--root", root, "--json", "--since", "all"],
		{ encoding: "utf8" },
	);
	return JSON.parse(out) as Report;
}

function smell(report: Report): Smell | undefined {
	return report.smells.find((entry) => entry.id === "config-resolution");
}

const CANONICAL_DOCUMENT = {
	tier: "project",
	file: "~/Desktop/proj/.pi-lens.json",
	legacy: false,
};
const LEGACY_DOCUMENT = {
	tier: "project",
	file: "~/Desktop/proj/pi-lens.json",
	legacy: true,
};

describe("config-resolution smell (#2526)", () => {
	it("stays silent when every session that expected a resolution has its row", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "s1", expected: true, full: true },
					{ id: "s2", expected: true, full: true },
				],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
					configResolvedRow({
						sessionId: "s2",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 2,
			sessionsExpectingResolution: 2,
			sessionsWithoutResolution: 0,
			legacyDocuments: 0,
			legacyWithoutRecords: 0,
		});
	});

	it("flags the sessions that expected a resolution and produced no row", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "s1", expected: true, full: true },
					{ id: "s2", expected: true, full: true },
					{ id: "s3", expected: true, full: true },
				],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(found, "expected a config-resolution smell").toBeDefined();
		expect(found?.count).toBe(2);
		expect(found?.description).toContain("no config_resolved row (2 of 3)");
		expect(report.config.sessionsWithoutResolution).toBe(2);
		// The example must name the session, so a reader can grep both logs for it.
		expect(JSON.stringify(found?.examples)).toContain("s2");
	});

	/**
	 * F2's masking probe, verbatim: two FULL sessions resolve nothing while two
	 * QUICK sessions each write a row. `starts - resolved` is 2 - 2 = 0, so the
	 * old smell reported total silence in the full path as perfectly healthy.
	 */
	it("a quick session's row cannot cancel a full session's missing one", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "full-1", expected: true, full: true },
					{ id: "full-2", expected: true, full: true },
					{ id: "quick-1", expected: true, full: false },
					{ id: "quick-2", expected: true, full: false },
				],
				latency: [
					configResolvedRow({
						sessionId: "quick-1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
					configResolvedRow({
						sessionId: "quick-2",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(
			found,
			"two full sessions resolved nothing and the smell stayed silent",
		).toBeDefined();
		expect(found?.count).toBe(2);
		expect(report.config.sessionsWithoutResolution).toBe(2);
	});

	/** The clean quick session on its own: a row, no `session_start cwd:` line. */
	it("a quick session with its row is not a smell", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "quick-1", expected: true, full: false }],
				latency: [
					configResolvedRow({
						sessionId: "quick-1",
						documents: [CANONICAL_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			sessionsExpectingResolution: 1,
			sessionsWithoutResolution: 0,
		});
	});

	/**
	 * The inverse F2 names: a session that never resolves config by DESIGN
	 * (`--no-lsp`, or a subagent whose LSP pre-warm is skipped by #449) still
	 * writes its start line. Counting it produced a permanent false deficit.
	 */
	it("a --no-lsp or subagent session is never counted against", () => {
		const report = runReport(
			buildRoot({
				sessions: [
					{ id: "nolsp", expected: false, full: true, reason: "no-lsp" },
					{ id: "sub", expected: false, full: true, reason: "subagent" },
				],
				latency: [],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 0,
			sessionsExpectingResolution: 0,
			sessionsWithoutResolution: 0,
		});
	});

	it("flags a legacy document that produced zero migration records", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "s1", expected: true, full: true }],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [LEGACY_DOCUMENT],
						recordCount: 0,
					}),
				],
			}),
		);
		const found = smell(report);
		expect(found?.count).toBe(1);
		expect(report.config).toMatchObject({
			resolved: 1,
			sessionsWithoutResolution: 0,
			legacyDocuments: 1,
			legacyWithoutRecords: 1,
		});
		// The example must name the offending document — a smell whose example
		// prints only a phase name costs the reader a second forensics pass.
		expect(JSON.stringify(found?.examples)).toContain(
			"project:~/Desktop/proj/pi-lens.json (legacy)",
		);
	});

	it("does not flag a legacy document that DID produce records", () => {
		const report = runReport(
			buildRoot({
				sessions: [{ id: "s1", expected: true, full: true }],
				latency: [
					configResolvedRow({
						sessionId: "s1",
						documents: [LEGACY_DOCUMENT],
						recordCount: 2,
					}),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			legacyDocuments: 1,
			legacyWithoutRecords: 0,
		});
	});

	/**
	 * The `config resolved … session=<id>` line the loader writes to
	 * sessionstart.log satisfies the join on its own. The two sinks are written
	 * by ONE call at one instant, so this is not a second source of truth — it
	 * is the same fact surviving an independent rotation of latency.log.
	 */
	it("the sessionstart config-resolved line alone satisfies the join", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgsmell-"));
		roots.push(dir);
		fs.writeFileSync(path.join(dir, "latency.log"), "");
		fs.writeFileSync(
			path.join(dir, "sessionstart.log"),
			`[${NOW}] session_start config-resolution session=s1 expected=true reason=ok\n` +
				`[${NOW}] config resolved documents=1 legacy=0 records=0 deniedServers=0 resolveMs=2 session=s1\n`,
		);
		const report = runReport(dir);
		expect(smell(report)).toBeUndefined();
		expect(report.config.sessionsWithoutResolution).toBe(0);
	});
});
