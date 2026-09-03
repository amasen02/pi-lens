/**
 * #2526: `npm run logs:smells` gains a "config resolution" smell.
 *
 * Two shapes, one smell id, asserted against the real script run as a
 * subprocess over a crafted log root — the same harness
 * `analyze-pi-lens-logs.test.ts` uses, kept in its own file so the shared
 * fixture's existing count assertions stay untouched:
 *
 * 1. A session start with no `config_resolved` row. Counted as a deficit of
 *    rows against `session_start cwd:` lines, because the two facts live in
 *    different logs.
 * 2. A `config_resolved` row carrying a LEGACY document that produced zero
 *    migration records — the deprecation machinery gone silent while the user
 *    sits on a removal schedule.
 *
 * A canonical-only session with its row present must produce NO smell: silence
 * has to mean "resolved and clean", which is the whole point of the issue.
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
		sessionsWithoutResolution: number;
		legacyDocuments: number;
		legacyWithoutRecords: number;
	};
}

function configResolvedRow(
	documents: Array<{ tier: string; file: string; legacy: boolean }>,
	recordCount: number,
): Record<string, unknown> {
	return {
		type: "phase",
		ts: NOW,
		phase: "config_resolved",
		filePath: "/home/u/Desktop/proj",
		durationMs: 3,
		metadata: {
			documents,
			countsByTier: { builtin: 0, global: 0, project: 4 },
			recordCount,
			deniedServers: 0,
			resolveMs: 3,
		},
	};
}

function buildRoot(options: {
	sessionStarts: number;
	latency: Array<Record<string, unknown>>;
}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgsmell-"));
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, "latency.log"),
		`${options.latency.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	const starts = Array.from(
		{ length: options.sessionStarts },
		() => `[${NOW}] session_start cwd: /home/u/Desktop/proj`,
	);
	fs.writeFileSync(
		path.join(dir, "sessionstart.log"),
		`${starts.join("\n")}\n`,
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
	it("stays silent when every session start has a clean config_resolved row", () => {
		const report = runReport(
			buildRoot({
				sessionStarts: 2,
				latency: [
					configResolvedRow([CANONICAL_DOCUMENT], 0),
					configResolvedRow([CANONICAL_DOCUMENT], 0),
				],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			resolved: 2,
			sessionsWithoutResolution: 0,
			legacyDocuments: 0,
			legacyWithoutRecords: 0,
		});
	});

	it("flags session starts that produced no config_resolved row", () => {
		const report = runReport(
			buildRoot({
				sessionStarts: 3,
				latency: [configResolvedRow([CANONICAL_DOCUMENT], 0)],
			}),
		);
		const found = smell(report);
		expect(found, "expected a config-resolution smell").toBeDefined();
		expect(found?.count).toBe(2);
		expect(found?.description).toContain("no config_resolved row (2 of 3)");
		expect(report.config.sessionsWithoutResolution).toBe(2);
	});

	it("flags a legacy document that produced zero migration records", () => {
		const report = runReport(
			buildRoot({
				sessionStarts: 1,
				latency: [configResolvedRow([LEGACY_DOCUMENT], 0)],
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
				sessionStarts: 1,
				latency: [configResolvedRow([LEGACY_DOCUMENT], 2)],
			}),
		);
		expect(smell(report)).toBeUndefined();
		expect(report.config).toMatchObject({
			legacyDocuments: 1,
			legacyWithoutRecords: 0,
		});
	});
});
