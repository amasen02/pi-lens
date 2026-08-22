/**
 * Oxlint runner for dispatch system
 *
 * Fast JavaScript/TypeScript linter written in Rust.
 * Drop-in replacement for ESLint with better performance.
 *
 * Requires: oxlint (npm install -g oxlint)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { walkUpDirs } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	getJstsLintPolicyForCwd,
	hasVitePlusConfig,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const OXLINT_NO_FILES = Symbol("oxlint-no-files");
const OXLINT_NO_FILES_BANNER =
	"No files found to lint. Please check your paths and ignore patterns.";
const OXLINT_NO_FILES_REPORT_KEYS = new Set([
	"diagnostics",
	"number_of_files",
	"number_of_rules",
	"threads_count",
	"start_time",
]);

function resolveLocalVp(cwd: string): string | null {
	const isWin = process.platform === "win32";
	for (const dir of walkUpDirs(cwd)) {
		const candidates = isWin
			? [
					path.join(dir, "node_modules", ".bin", "vp.cmd"),
					path.join(dir, "node_modules", ".bin", "vp"),
				]
			: [path.join(dir, "node_modules", ".bin", "vp")];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

async function resolveVitePlusCommand(cwd: string): Promise<string | null> {
	const local = resolveLocalVp(cwd);
	if (local) return local;
	const version = await safeSpawnAsync("vp", ["--version"], {
		timeout: 5000,
		cwd,
	});
	return !version.error && version.status === 0 ? "vp" : null;
}

const oxlintRunner: RunnerDefinition = {
	id: "oxlint",
	appliesTo: ["jsts"],
	priority: PRIORITY.LINT_SECONDARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getJstsLintPolicyForCwd(cwd);
		if (!policy.preferredRunners.includes("oxlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		let args: string[];
		if (hasVitePlusConfig(cwd)) {
			cmd = await resolveVitePlusCommand(cwd);
		}
		if (cmd) {
			args = ["lint", "--format", "json", ctx.filePath];
		} else {
			// Use ctx.hasTool for async availability check — avoids the synchronous
			// spawnSync probe that blocks the event loop on first call per cwd.
			// FactStore caches the result for the session so subsequent writes are free.
			const oxlintCmd = resolveToolCommand(cwd, "oxlint") ?? "oxlint";
			cmd = (await ctx.hasTool(oxlintCmd))
				? oxlintCmd
				: await resolveToolCommandWithInstallFallback(cwd, "oxlint");
			args = ["--format", "json", ctx.filePath];
		}
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run oxlint (or Vite+'s vp lint wrapper) on the file.
		const result = await safeSpawnAsync(cmd, args, {
			timeout: 30000,
		});

		// Oxlint exits 0 whenever nothing at ERROR severity was found — that
		// includes a run that found only warnings, its own default severity
		// (#1947). A run that found nothing at all also exits 0, but still
		// prints a report with an empty `diagnostics` array, so parsing
		// unconditionally and branching on the parsed count (below) tells the
		// two apart instead of the exit code discarding the warning case.
		//
		// Parse JSON output. Fall back to the unix-format parser if JSON parsing
		// fails (older oxlint versions, malformed stderr noise, etc.) — keeps the
		// runner producing diagnostics even when the structured-fix metadata is
		// unavailable.
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const parsedOutput = stdout + stderr;
		// #1994's shared gate classifies invocation and parsed-output failures.
		// The private marker lets its parser recognize oxlint's one legitimate
		// nonzero/zero-diagnostic shape without recording a parsed-nothing
		// degradation. It never escapes this runner. Because parseToolRun checks
		// the process outcome before invoking the parser, a timed-out or killed
		// process retaining partial no-files stdout still follows the failure path.
		const parsedRun = parseToolRun<Diagnostic | typeof OXLINT_NO_FILES>(
			"oxlint",
			{ result, output: parsedOutput },
			() => {
				let parsed = parseOxlintJson(stdout, ctx.filePath);
				if (parsed.length === 0 && stdout.length > 0) {
					parsed = parseOxlintUnix(parsedOutput, ctx.filePath);
				}
				return parsed.length === 0 &&
					isExpectedOxlintNoFiles(result.status, stdout, stderr)
					? [OXLINT_NO_FILES]
					: parsed;
			},
			{ parseOutput: parsedOutput },
		);
		if (parsedRun.skipped) return parsedRun.skipped;

		if (parsedRun.diagnostics.includes(OXLINT_NO_FILES)) {
			// Real captured bytes show oxlint exits
			// 1 with "No files found" + number_of_files: 0 when a config excludes
			// the target, so "nonzero exit" alone cannot mean "unreadable report
			// of problems" until the no-files shape is ruled out.
			// Read BEFORE reporting "succeeded" — a config (root's or a nested
			// one nearer the file, per oxlint's own discovery) that ignores this
			// file reports the same empty diagnostics array a clean file does.
			// "succeeded"/"none" would say "we checked, it's clean"; this file
			// was never checked at all.
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "no-files-matched",
			};
		}
		const diagnostics = parsedRun.diagnostics.filter(
			(diagnostic): diagnostic is Diagnostic => diagnostic !== OXLINT_NO_FILES,
		);

		// A warning-only result on exit 0 is oxlint's normal outcome, not a
		// failure: exit 0 means nothing hit ERROR severity. `status: "failed"`
		// here would stop this arm from reporting "succeeded", which breaks two
		// things downstream — plan.ts's ["eslint", "oxlint", "biome-check-json"]
		// fallback group only stops at the first `status: "succeeded"` runner
		// (dispatcher.ts's `runGroup`), so biome-check-json would run again on
		// every warning-only save (extra spawns, a possible install, duplicate
		// findings); and it would mismatch the sibling convention (biome-check,
		// golangci-lint, rubocop) of keying `status` off blocking severity, not
		// off the tool's raw exit code. The findings themselves still reach the
		// delivery pipeline regardless of `status` — dispatcher.ts buckets by
		// each diagnostic's own `semantic`, so a warning stays a warning.
		return finishParsedRun({
			tool: "oxlint",
			ctx,
			result,
			diagnostics,
			classify: (diagnostics) => {
				const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
				return {
					status: !hasBlocking && result.status === 0 ? "succeeded" : "failed",
					semantic: hasBlocking ? "blocking" : "warning",
				};
			},
		});
	},
};

interface OxlintLabel {
	span?: { offset?: number; length?: number; line?: number; column?: number };
}

interface OxlintJsonDiagnostic {
	message?: string;
	code?: string;
	severity?: string;
	help?: string;
	filename?: string;
	labels?: OxlintLabel[];
}

interface OxlintJsonReport {
	diagnostics?: OxlintJsonDiagnostic[];
	number_of_files?: number;
}

/**
 * Recognize only oxlint's captured expected no-files envelope. The numeric
 * field alone is not a verdict: config errors can also serialize
 * `number_of_files: 0`, and stderr accompanying an otherwise familiar stdout
 * means the invocation did not produce the clean expected-policy outcome.
 *
 * Real oxlint 1.79.0 prints "No files found to lint. Please check your paths
 * and ignore patterns." to stdout before a JSON summary, exits 1, emits an
 * empty diagnostics array, and leaves stderr empty. Unknown JSON fields fail
 * closed so an error/message payload cannot borrow the expected skip merely
 * by also setting the file count to zero. Rejected lookalikes continue through
 * `parseToolRun`, preserving #1994 parsed-nothing telemetry.
 */
function isExpectedOxlintNoFiles(
	status: number | null | undefined,
	stdout: string,
	stderr: string,
): boolean {
	if (status !== 1 || stderr.trim().length > 0) return false;
	const jsonStart = stdout.indexOf("{");
	if (jsonStart === -1) return false;
	if (stdout.slice(0, jsonStart).trim() !== OXLINT_NO_FILES_BANNER)
		return false;
	try {
		const parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return false;
		}
		const report = parsed as Record<string, unknown>;
		if (
			Object.keys(report).some((key) => !OXLINT_NO_FILES_REPORT_KEYS.has(key))
		) {
			return false;
		}
		return (
			report.number_of_files === 0 &&
			Array.isArray(report.diagnostics) &&
			report.diagnostics.length === 0
		);
	} catch {
		return false;
	}
}

// Oxlint codes look like "eslint(no-debugger)" or "oxc(approx-constant)".
// Strip the plugin prefix so the rule lines up with what users expect.
// indexOf-based extraction avoids a regex hot-spot Sonar flagged for
// potential super-linear backtracking on adversarial inputs.
function extractOxlintRule(code: string | undefined): string {
	if (!code) return "unknown";
	const open = code.indexOf("(");
	if (open === -1) return code;
	const close = code.indexOf(")", open + 1);
	if (close === -1 || close === open + 1) return code;
	return code.slice(open + 1, close);
}

function parseOxlintJson(raw: string, filePath: string): Diagnostic[] {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{")) return [];
	let parsed: OxlintJsonReport;
	try {
		parsed = JSON.parse(trimmed) as OxlintJsonReport;
	} catch {
		return [];
	}
	const diagnostics: Diagnostic[] = [];
	for (const d of parsed.diagnostics ?? []) {
		const rule = extractOxlintRule(d.code);
		const label = d.labels?.[0]?.span;
		const lineNum = label?.line ?? 1;
		const colNum = label?.column ?? 1;
		const severity = d.severity === "error" ? "error" : "warning";
		const help = d.help?.trim();
		diagnostics.push({
			id: `oxlint-${rule}-${lineNum}`,
			message: `${d.message ?? "oxlint issue"} (${rule})`,
			filePath,
			line: lineNum,
			column: colNum,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "oxlint",
			rule,
			// Oxlint's help text is rule-specific guidance ("Remove the debugger
			// statement", "Consider removing this declaration"). Surface it as a
			// fix suggestion so the warning becomes actionable instead of falling
			// silently into code-quality.
			fixSuggestion: help && help.length > 0 ? help : undefined,
		});
	}
	return diagnostics;
}

function parseOxlintUnix(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split("\n")) {
		// Parse: file:line:column: message (rule)
		const match = line.match(/^(.+):(\d+):(\d+):\s*(.+?)\s*\(([^)]+)\)$/);
		if (match) {
			const [, _file, lineStr, _col, message, rule] = match;
			diagnostics.push({
				id: `oxlint-${rule}-${lineStr}`,
				message: `${message} (${rule})`,
				filePath,
				line: parseInt(lineStr, 10),
				severity: "warning",
				semantic: "warning",
				tool: "oxlint",
				rule,
			});
		}
	}
	return diagnostics;
}

export default oxlintRunner;
