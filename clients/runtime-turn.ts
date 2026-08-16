import * as path from "node:path";
import {
	appendActionableWarningsHistory,
	buildActionableWarningsReport,
	formatActionableWarningsAdvisory,
	writeActionableWarningsReport,
} from "./actionable-warnings.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	writeCodeQualityWarningsReport,
} from "./code-quality-warnings.js";
import type { CacheManager } from "./cache-manager.js";
import type { CascadeSkipReason } from "./cascade-types.js";
import {
	clearGitGuardTestFailure,
	mergeGitGuardTestFailure,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "./git-guard.js";
import { logCascade } from "./cascade-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import type {
	DependencyChecker,
	MadgeBatchStats,
} from "./dependency-checker.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import { isTestRoleCollateral } from "./collateral-test-role.js";
import type { GitleaksResult } from "./gitleaks-client.js";
import type { GovulncheckResult } from "./govulncheck-client.js";
import type { TrivyResult } from "./trivy-client.js";
import {
	dedupeSecretFindings,
	fromAstGrepWarnings,
	fromGitleaks,
	fromTrivySecrets,
	isSecretWarning,
	secretLocationKey,
} from "./secret-findings.js";
import type { KnipClient, KnipIssue, KnipResult } from "./knip-client.js";
import type { DeadCodeClient, DeadCodeResult } from "./dead-code-client.js";
import { formatDeadCodeAdvisory } from "./dead-code-client.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.js";
import { knipIssuesToProjectDiagnostics } from "./project-diagnostics/runner-adapters/knip.js";
import type { ProjectDiagnostic } from "./project-diagnostics/types.js";
import { logLatency } from "./latency-logger.js";
import {
	getLspBudgetIdleTimeoutMs,
	shouldShortenLspIdleTimeout,
} from "./lsp-budget.js";
import { updateHeartbeat } from "./instance-registry.js";
import { emitLensTurnFindings } from "./lens-events.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { isSubagentSession } from "./subagent-mode.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { TurnStateOwner } from "./cache-manager.js";
import { formatRunDurationMs } from "./run-duration.js";
import type { TestResult, TestRunnerClient } from "./test-runner-client.js";
import {
	MAX_ADVISORY_AFFECTED_FILES,
	dropFindingsForMissingPaths,
	snapshotAdvisoryProvenance,
} from "./advisory-provenance.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	knipClient: KnipClient;
	deadCodeClients: DeadCodeClient[];
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	/** Explicit owner for MCP Stop-hook calls; pi calls use runtime identity. */
	owner?: TurnStateOwner;
	resetLSPService: () => void;
	resetFormatService: () => void;
}

// LSP idle reset scheduling — prevents thrashing by delaying shutdown
let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;

function emitIdleResetReporterWarning(reportErr: unknown): void {
	try {
		process.emitWarning(
			`pi-lens LSP idle reset error reporter failed: ${reportErr}`,
			{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
		);
	} catch {
		// Preserve the detached-timer invariant: this path must never crash.
		void reportErr;
	}
}

function reportIdleResetError(
	onError: ((err: unknown) => void) | undefined,
	err: unknown,
): void {
	try {
		onError?.(err);
	} catch (reportErr) {
		emitIdleResetReporterWarning(reportErr);
	}
}

function scheduleLSPIdleReset(
	resetFn: () => void,
	delayMs: number,
	options: {
		isCurrentSession?: () => boolean;
		onError?: (err: unknown) => void;
	} = {},
): void {
	// Clear any pending reset to avoid multiple timers
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
	}
	lspIdleResetTimeout = setTimeout(() => {
		lspIdleResetTimeout = null;
		try {
			if (options.isCurrentSession && !options.isCurrentSession()) {
				return;
			}
			resetFn();
		} catch (err) {
			// Detached timers run outside a pi event boundary. They must never crash
			// the extension process (for example if a host UI object was invalidated
			// by session replacement before the timer fired).
			reportIdleResetError(options.onError, err);
		}
	}, delayMs);
	// unref so this timer does not prevent the process from exiting naturally
	// (critical for subagent / --mode json -p usage where the process should
	// exit after completing its work, not wait 240 seconds for this to fire)
	lspIdleResetTimeout.unref();
}

export function cancelLSPIdleReset(): void {
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
	}
}

// Bounded wait for the turn's deferred cascade computes (#450) to settle before
// they are merged below. A late compute is carried over to the next turn_end.
function cascadeSettleWaitMs(): number {
	const raw = Number(process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

function capTurnEndMessage(content: string): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

	let out = content;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
	}
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n... (truncated)`;
	}

	return out;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		knipClient,
		deadCodeClients,
		depChecker,
		testRunnerClient,
		owner,
		resetLSPService,
		resetFormatService,
	} = deps;

	// #449 slice 1: piggyback the instance-registry heartbeat on this existing
	// per-turn touchpoint rather than adding a new timer/interval. Cheap (reads
	// process.memoryUsage().rss, one read-modify-write of instances.json) and
	// fire-and-forget — the kill-switch check + no-op behavior live inside
	// updateHeartbeat itself, so this call site doesn't need to know about it.
	//
	// #620: intentionally RSS-only here — CPU%/LSP-child sampling (which shells
	// out to `pidusage`, and a full CIM query on Windows for a spawn's process
	// tree) is left to the quiet-window "instance_registry_heartbeat" task
	// (clients/quiet-window.ts's `buildHeartbeatResourcePatch`), which fires on
	// the idle `agent_settled` window rather than every single turn end. Every
	// turn end is a much hotter path than an idle window, and the issue's own
	// guardrail is not to let the measurement itself become a new source of
	// per-turn overhead worth investigating.
	void updateHeartbeat().catch(() => {
		// best-effort observability — never fail turn_end over this
	});

	const cwd = ctxCwd ?? process.cwd();
	let turnState = cacheManager.readTurnState(cwd);

	// A live foreign writer owns this worklist. Do not clear or consume another
	// pi/MCP session's files; a dead/aged owner is safely evicted instead.
	const currentOwner: TurnStateOwner = owner ?? {
		kind: "pi",
		id: runtime.telemetrySessionId,
		pid: process.pid,
		lastSeen: new Date().toISOString(),
	};
	const access = cacheManager.getTurnStateAccess(cwd, currentOwner);
	const sameProcessPiSessionHandoff =
		access === "foreign-live" &&
		currentOwner.kind === "pi" &&
		turnState.owner?.kind === "pi" &&
		turnState.owner.pid === process.pid &&
		turnState.owner.id !== currentOwner.id;
	if (access === "foreign-live" && !sameProcessPiSessionHandoff) {
		dbg(
			`turn_end: foreign live owner retained (${turnState.owner?.kind ?? "legacy"}:${turnState.owner?.id ?? turnState.sessionId})`,
		);
		return;
	}
	if (access === "available" && (turnState.files || turnState.owner || turnState.sessionId)) {
		dbg("turn_end: evicting stale turn-state owner");
		cacheManager.clearTurnState(cwd, currentOwner);
		turnState = cacheManager.readTurnState(cwd);
	}

	const files = Object.keys(turnState.files);

	// R1 (#1443 follow-up): a read-only turn (no files touched) must not take
	// the fast idle-reset path while a carried cascade run — or one still
	// settling — is waiting for its delivery opportunity. Falling through to
	// the normal pipeline lets the settle/drain/merge logic below run exactly
	// as it does for an edit turn, so a carried finding reaches the agent
	// instead of dying unrendered. `hasCascadeRuns()` is a cheap peek (no
	// pending work almost every turn), so the common read-only turn still
	// takes the early return below.
	if (files.length === 0 && !runtime.hasCascadeRuns()) {
		// A genuinely clean session must invalidate the persisted guard record.
		// Blocker records are retained only while the runtime still reports one.
		if (getFlag("lens-guard") && !runtime.gitGuardHasBlockers) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
		// #713: subagent sessions use a shorter idle reset (60s) — a short-lived
		// task agent holding a warm fleet for 4 minutes after its last turn is
		// pure waste under fan-out. Classify ONCE here so every tick in this call
		// path shares the same answer. PI_LENS_SUBAGENT_FULL=1 restores 240s via
		// isSubagentSession() returning false.
		const idleResetMs =
			isSubagentSession() || shouldShortenLspIdleTimeout()
				? getLspBudgetIdleTimeoutMs()
				: 240_000;
		dbg(
			`turn_end: no modified files, scheduling LSP idle reset (${idleResetMs / 1000}s)`,
		);
		if (!getFlag("no-lsp")) {
			const sessionGeneration = runtime.sessionGeneration;
			scheduleLSPIdleReset(resetLSPService, idleResetMs, {
				isCurrentSession: () => runtime.isCurrentSession(sessionGeneration),
				onError: (err) => dbg(`lsp idle reset failed: ${err}`),
			});
		}
		resetFormatService();
		return;
	}

	// Cancel any pending idle reset since we're actively working
	if (lspIdleResetTimeout) {
		cancelLSPIdleReset();
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd, currentOwner);
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const turnEndStart = Date.now();
	const blockerParts: string[] = [];
	const advisoryParts: string[] = [];
	const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
	const projectDiagnosticsSources = new Set<string>();

	// Re-surface inline blockers from this turn that the agent didn't fix.
	// These were shown inline during write/edit but the agent moved on without resolving them.
	const unresolvedBlockers = runtime.getInlineBlockersSnapshot();
	for (const { filePath: bPath, summary } of unresolvedBlockers) {
		const displayPath = toRunnerDisplayPath(cwd, bPath);
		blockerParts.push(
			`Unresolved from this turn — ${displayPath}:\n${summary}`,
		);
	}

	// Drain the deferred cascade computes kicked off this turn (#450). They ran
	// concurrently off the write hot path; wait a bounded time for them here so
	// their runs are available to the merge below. A compute still in flight at
	// the cap is carried over to the next turn_end (never dropped).
	const cascadeSettleStart = Date.now();
	const { settled, timedOut } = await runtime.settleCascadeRuns(
		cascadeSettleWaitMs(),
	);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_settle_wait",
		durationMs: Date.now() - cascadeSettleStart,
		metadata: { settled, timedOut },
	});

	// Merge accumulated cascade results from all pipeline runs this turn.
	// Two-pass dedup:
	//   1. Primary-level: dedup by primary file (last writer wins).
	//   2. Neighbor-level: each neighbor is claimed by the latest cascade result
	//      that covers it — suppresses stale neighbor state from earlier writes.
	const t0 = Date.now();
	const cascadeRuns = runtime.consumeCascadeRuns().filter((run) => {
		const originSeq = run.origin?.projectSeq;
		const originTurn = run.origin?.turnSeq;
		// A deferred result from AFTER a later write is not current state. Old test
		// fixtures without provenance remain accepted for compatibility.
		//
		// #1443: `turnSeq` alone is NOT a supersede signal, and it used to be an
		// unconditional reject. Every LATE run — one whose compute missed the
		// settle cap and was re-parked by `settleCascadeRuns`, and one the
		// quiet-window reconcile appended after this turn's predecessor already
		// consumed (carried across turn_start by `beginTurn`) — is BY DEFINITION
		// from an earlier turn, so `originTurn === runtime.turnIndex` was always
		// false for exactly the runs the carry-over was built to preserve. Both
		// producers' contracts were dead code: the measured cases were the two
		// highest-fan-out cascades of the day (38 and 40 neighbours).
		//
		// R2 (#1443 follow-up): `projectSeq` alone is NOT a per-file supersede
		// signal — it is GLOBAL, advancing on every pi-observed write anywhere in
		// the project. Rejecting on any mismatch meant an edit to an unrelated
		// file superseded a run that had nothing to do with it, reintroducing the
		// exact 38/40-neighbour loss #1443 was written to fix, one filter down.
		// `getFilesChangedSince` (#451) is the honest per-file signal: a run is
		// superseded only if its own primary file or one of its neighbours was
		// actually rewritten since it launched. A late-but-not-superseded run is
		// surfaced; a superseded one is dropped with a RECORD (never silently),
		// so the loss stays countable.
		if (originSeq !== undefined) {
			const changedSince = runtime.getFilesChangedSince(originSeq);
			if (changedSince.length > 0) {
				const changedSet = new Set(changedSince);
				const primaryKey = normalizeMapKey(path.resolve(run.filePath));
				const neighborKeys = (run.result?.neighbors ?? []).map((n) =>
					normalizeMapKey(path.resolve(n.filePath)),
				);
				const supersededByOwnFile =
					changedSet.has(primaryKey) ||
					neighborKeys.some((k) => changedSet.has(k));
				if (supersededByOwnFile) {
					logCascade({
						phase: "cascade_carry_over_drop",
						filePath: run.filePath,
						neighborCount: run.neighborCount,
						diagnosticCount: run.diagnosticCount,
						reason: "superseded_by_later_write",
						metadata: {
							originProjectSeq: originSeq,
							projectSeq: runtime.projectSeq,
							originTurnSeq: originTurn,
							turnIndex: runtime.turnIndex,
							carriedTurns: run.carriedTurns,
							changedFiles: changedSince,
						},
					});
					return false;
				}
			}
		}
		return true;
	});
	const cascadeResults = cascadeRuns.flatMap((r) =>
		r.result ? [r.result] : [],
	);
	if (cascadeResults.length > 0) {
		const seen = new Map<string, (typeof cascadeResults)[number]>();
		for (const result of cascadeResults) {
			seen.set(normalizeMapKey(result.filePath), result);
		}
		// Iterate in reverse so the latest result claims each neighbor first.
		const neighborOwner = new Map<string, string>();
		for (const result of [...seen.values()].reverse()) {
			const pk = normalizeMapKey(result.filePath);
			for (const n of result.neighbors) {
				const nk = normalizeMapKey(n.filePath);
				if (!neighborOwner.has(nk)) neighborOwner.set(nk, pk);
			}
		}
		const parts: string[] = [];
		// #1446 item 1: track what actually gets injected — a suppressed result
		// (real formatted cascade text, but every one of its neighbors was claimed
		// by a LATER result — see the reverse-iteration ownership pass above) was
		// previously indistinguishable from "no output"; this counts it explicitly
		// instead of letting it vanish.
		let injectedNeighborCount = 0;
		let injectedDiagnosticCount = 0;
		let suppressedByOwnership = 0;
		for (const result of seen.values()) {
			const pk = normalizeMapKey(result.filePath);
			const ownsAny = result.neighbors.some(
				(n) => neighborOwner.get(normalizeMapKey(n.filePath)) === pk,
			);
			if (ownsAny && result.formatted) {
				parts.push(result.formatted);
				injectedNeighborCount += result.neighbors.length;
				injectedDiagnosticCount += result.neighbors.reduce(
					(s, n) => s + n.diagnostics.length,
					0,
				);
			} else if (!ownsAny && result.formatted) {
				suppressedByOwnership++;
			}
		}
		// Suggest tests for cascade neighbors (files with diagnostics)
		const neighborFilesWithErrors = cascadeResults
			.flatMap((r) => r.neighbors)
			.filter((n) => n.diagnostics.length > 0)
			.map((n) => n.filePath);
		const uniqueNeighborFiles = [...new Set(neighborFilesWithErrors)];
		let testSuggestionCount = 0;
		if (
			uniqueNeighborFiles.length > 0 &&
			typeof testRunnerClient.suggestTestFiles === "function"
		) {
			const testSuggestions = testRunnerClient.suggestTestFiles(
				uniqueNeighborFiles,
				cwd,
			);
			testSuggestionCount = testSuggestions.length;
			// #1446 item 2: this path previously emitted nothing to any log — a
			// zero-suggestion outcome (neighbors had errors but no test file
			// resolved for any of them) is the more interesting case, so it is
			// recorded on the same phase rather than only logging on a hit.
			logCascade({
				phase: "cascade_test_targets",
				filePath: files[0] ?? cwd,
				neighborCount: uniqueNeighborFiles.length,
				metadata: {
					neighborFiles: uniqueNeighborFiles.slice(0, 10),
					suggestedTestFiles: testSuggestions.slice(0, 10).map((s) => s.testFile),
					runner: testSuggestions[0]?.runner,
					truncated: testSuggestions.length > 10,
					zeroSuggestions: testSuggestions.length === 0,
				},
			});
			if (testSuggestions.length > 0) {
				const testLines = testSuggestions
					.slice(0, 5)
					.map(
						(s) => `  ${toRunnerDisplayPath(cwd, s.testFile)} (${s.runner})`,
					);
				let testSection = `🧪 Likely tests for affected neighbors:\n${testLines.join("\n")}`;
				if (testSuggestions.length > 5) {
					testSection += `\n  ... and ${testSuggestions.length - 5} more`;
				}
				parts.push(testSection);
			}
		}
		if (parts.length > 0) {
			const section = parts.join("\n\n");
			blockerParts.push(section);
			// #1446 item 1: proves the cascade section reached `blockerParts` —
			// i.e. it was QUEUED for persistence into the turn-end advisory — not
			// that it reached the agent. The counters alone (cascade_result,
			// cascade_turn_end) never confirmed even that much, only computation.
			// Actual delivery happens later, via consumeTurnEndFindings/
			// peekTurnEndFindings, and can still be suppressed after this point
			// (e.g. allFilesDeleted, cross-turn dedup, or the session ending
			// before the next turn_end drains it) — this record does not prove
			// the agent ever saw the text.
			logCascade({
				phase: "cascade_injected",
				filePath: files[0] ?? cwd,
				neighborCount: injectedNeighborCount,
				diagnosticCount: injectedDiagnosticCount,
				metadata: {
					sectionChars: section.length,
					testSuggestionCount,
					suppressedByOwnership,
				},
			});
		}
		logCascade({
			phase: "cascade_turn_end",
			filePath: files[0] ?? cwd,
			neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
			diagnosticCount: cascadeResults.reduce(
				(s, r) =>
					s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
				0,
			),
			metadata: {
				fileCount: cascadeResults.length,
				mergedResults: seen.size,
			},
		});
	}
	// #1023: surface an HONEST note whenever a cascade run could not compute
	// downstream impact (degraded/over-cap graph, missing node, or a thrown
	// compute) — never a silent all-clear (#533). This goes to the ADVISORY tier,
	// NOT the blocker tier: in an over-cap monorepo the graph is `skipped` on
	// every edit, so a blocker would fire hard and never clear turn state every
	// turn (over-escalation — the mirror of the silent-all-clear bug). Advisory
	// still reaches the agent, just without the blocker mechanics. Keyed strictly
	// off the `indeterminate` marker threaded by the compute; a healthy build
	// with a genuinely empty dependent set carries no marker and stays silent
	// (over-correction guard).
	const indeterminateRuns = cascadeRuns.filter((r) => r.indeterminate);
	if (indeterminateRuns.length > 0) {
		// #1104 (review P3 on PR #1143, rides with the resultId main body): this
		// preamble used to hardcode a graph-unavailability frame for EVERY
		// indeterminate reason. That's accurate for `graph_degraded`/
		// `missing_node`/`error` (the graph really couldn't produce a dependent
		// set), but `lsp_binding_rejected` is a DIFFERENT failure shape — the
		// graph WAS available and dependents WERE derived; only their LSP
		// diagnostics display was withheld because a fallback snapshot's content
		// binding didn't match current disk. Saying "the review graph was
		// unavailable" for that case mis-attributes the cause. Bucket by reason
		// family so each gets its own accurate frame.
		const buildAdvisory = (
			runs: typeof indeterminateRuns,
			frame: {
				lead: (fileCount: number, reasons: string) => string;
				fallbackDetail: (
					r: (typeof indeterminateRuns)[number],
				) => string;
			},
		): string | undefined => {
			if (runs.length === 0) return undefined;
			const byDetail = new Map<string, string[]>();
			for (const r of runs) {
				const detail = r.indeterminate?.detail ?? frame.fallbackDetail(r);
				const files = byDetail.get(detail) ?? [];
				files.push(toRunnerDisplayPath(cwd, r.filePath));
				byDetail.set(detail, files);
			}
			const lines: string[] = [];
			for (const [detail, filesRaw] of byDetail) {
				const files = [...new Set(filesRaw)];
				const shown = files.slice(0, 5).join(", ");
				const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
				lines.push(`  • ${detail}: ${shown}${more}`);
			}
			const fileCount = new Set(
				runs.map((r) => normalizeMapKey(r.filePath)),
			).size;
			const reasons = [...byDetail.keys()].join("; ");
			return `${frame.lead(fileCount, reasons)}\n${lines.join("\n")}`;
		};

		// #1445: `excluded_by_role` (test files excluded from the graph BY DESIGN,
		// #260) is never agent-facing — it is not a graph failure, and #1080
		// already excludes test-role files from every neighbor surface, so "a
		// clean result does not cover them" would itself be a false claim. It
		// stays visible in the `cascade_indeterminate` log below (metadata-only,
		// info-level) so the log can tell an intentional exclusion from a real
		// graph gap, but it never reaches `buildAdvisory`/the agent.
		const graphRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason !== "lsp_binding_rejected" &&
				r.indeterminate?.reason !== "excluded_by_role",
		);
		const bindingRuns = indeterminateRuns.filter(
			(r) => r.indeterminate?.reason === "lsp_binding_rejected",
		);

		// Factual/informational phrasing — the advisory tier wraps this with an
		// "ℹ️ Advisory — no action required this turn:" label, so an imperative
		// ("review dependents manually") would contradict it. The #533 substance
		// stays: a clean cascade result does NOT cover these files' dependents.
		const graphAdvisory = buildAdvisory(graphRuns, {
			lead: (fileCount, reasons) =>
				`Cascade could not compute downstream impact for ${fileCount} edited file(s) this turn — ` +
				`the review graph was unavailable (${reasons}), so their dependents were not ` +
				`cascade-checked and a clean cascade result does not cover them.`,
			fallbackDetail: (r) =>
				r.indeterminate?.reason === "missing_node"
					? "changed file not in the review graph"
					: "review graph unavailable",
		});
		if (graphAdvisory) advisoryParts.push(graphAdvisory);

		const bindingAdvisory = buildAdvisory(bindingRuns, {
			lead: (fileCount, reasons) =>
				`Cascade identified dependents for ${fileCount} edited file(s) this turn, but their ` +
				`diagnostics could not be freshly confirmed (${reasons}) and were withheld — a clean ` +
				`cascade result does not cover them.`,
			fallbackDetail: () => "cascade diagnostics withheld (binding rejected)",
		});
		if (bindingAdvisory) advisoryParts.push(bindingAdvisory);

		const fileCount = new Set(
			indeterminateRuns.map((r) => normalizeMapKey(r.filePath)),
		).size;
		logCascade({
			phase: "cascade_indeterminate",
			filePath: files[0] ?? cwd,
			metadata: {
				fileCount,
				reasons: indeterminateRuns.map((r) => r.indeterminate?.reason),
			},
		});
	}

	const cascadeSkipped: Record<CascadeSkipReason, number> = {
		blockers: 0,
		non_code: 0,
		no_neighbors: 0,
		clean: 0,
		indeterminate: 0,
		error: 0,
	};
	for (const r of cascadeRuns) {
		if (r.skipReason)
			cascadeSkipped[r.skipReason] = (cascadeSkipped[r.skipReason] ?? 0) + 1;
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_merge",
		durationMs: Date.now() - t0,
		metadata: {
			runsTotal: cascadeRuns.length,
			resultCount: cascadeResults.length,
			neighborCount: cascadeRuns.reduce((s, r) => s + r.neighborCount, 0),
			diagnosticCount: cascadeRuns.reduce((s, r) => s + r.diagnosticCount, 0),
			skipped: cascadeSkipped,
		},
	});

	const t2 = Date.now();
	let knipMeta: {
		skipped?: boolean;
		success?: boolean;
		totalIssues?: number;
		newIssues?: number;
		blockerIssues?: number;
		reason?: string;
		/** Set when the failure was an availability verdict, not a knip run. */
		failureKind?: string;
		/** True when a failed run left the previous good cache in place (#1467). */
		cacheKept?: boolean;
	} = {};
	if (runtime.isStartupScanInFlight("knip")) {
		dbg("turn_end: skipping knip (startup scan still in flight)");
		knipMeta = { skipped: true };
	} else {
		// Let KnipClient resolve/validate a real JS project root before probing or
		// auto-installing knip. Non-JS repos (for example Unity projects) should not
		// run tool checks every turn. Also back off after a timeout/kill so every
		// agent turn does not spend 30s launching another heavyweight knip process.
		const prevKnip = cacheManager.readCache<KnipResult>("knip", cwd);
		// An availability failure is NOT a hard knip failure: knip never ran, so
		// there is nothing to back off from, and backing off would make an
		// expiring probe verdict permanent again (#1467).
		const previousFailedHard =
			prevKnip &&
			!prevKnip.data.success &&
			!prevKnip.data.failureKind &&
			/(timed out|killed|SIGTERM|SIGKILL|SIGABRT)/i.test(prevKnip.data.summary);

		if (previousFailedHard) {
			dbg(
				`turn_end: skipping knip after recent failure: ${prevKnip.data.summary}`,
			);
			knipMeta = { skipped: true, reason: prevKnip.data.summary };
		} else {
			const knipResult = await knipClient.analyze(cwd, getKnipIgnorePatterns());
			// Never overwrite a good scan with a failure (#925, #1467): the 194-byte
			// "not available" record replaced 149 KB of real findings in every
			// dogfood project and readers then served the failure as the answer.
			// The last good result stays until a new successful scan replaces it.
			const wouldPoisonCache = !knipResult.success && prevKnip?.data.success;
			if (wouldPoisonCache) {
				dbg(
					`turn_end: keeping last good knip cache; this run failed: ${knipResult.summary}`,
				);
			} else {
				cacheManager.writeCache("knip", knipResult, cwd);
			}
			knipMeta = {
				success: knipResult.success,
				totalIssues: knipResult.issues.length,
				newIssues: 0,
				blockerIssues: 0,
				...(!knipResult.success && { reason: knipResult.summary }),
				...(knipResult.failureKind && { failureKind: knipResult.failureKind }),
				...(wouldPoisonCache && { cacheKept: true }),
			};

			if (knipResult.success && knipResult.issues.length > 0) {
				const issueKey = (i: KnipIssue) =>
					`${i.type}:${i.file ?? ""}:${i.name}:${i.line ?? 0}:${i.package ?? ""}`;
				const prevKeys = new Set((prevKnip?.data?.issues ?? []).map(issueKey));
				const modifiedSet = new Set(
					files.map((f) => resolveRunnerPath(cwd, f)),
				);

				const newIssues = knipResult.issues.filter((issue) => {
					if (prevKeys.has(issueKey(issue))) return false;
					if (!issue.file) return false;
					const abs = resolveRunnerPath(cwd, issue.file);
					return modifiedSet.has(abs);
				});
				knipMeta.newIssues = newIssues.length;
				if (newIssues.length > 0) {
					projectDiagnosticsDelta.push(
						...knipIssuesToProjectDiagnostics(cwd, newIssues),
					);
					projectDiagnosticsSources.add("knip");
				}

				const blockerIssues = newIssues.filter(
					(i) => i.type === "unlisted" || i.type === "bin",
				);
				knipMeta.blockerIssues = blockerIssues.length;
				if (blockerIssues.length > 0) {
					let report =
						"🔴 New unresolved imports/deps in modified code (Knip):\n";
					let firstPath: string | null = null;
					for (const issue of blockerIssues.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						if (!firstPath && display !== "(unknown)") firstPath = display;
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.type}: ${issue.name}\n`;
					}
					if (firstPath) {
						report += `  First location: ${firstPath}\n`;
					}
					blockerParts.push(report);
				}

				// Turn-end injects only this turn's HIGH-CONFIDENCE, ATTRIBUTABLE
				// delta: symbols in files the agent just edited that became unused
				// (weren't flagged in the previous scan) — low-volume and actionable
				// now. The FULL project-wide dead-code picture is deliberately NOT
				// injected per turn (hundreds of mostly-pre-existing findings would
				// drown the blockers and burn context every turn); it's available
				// on demand via lens_diagnostics. The delta also feeds the session-slop
				// record (`projectDiagnosticsDelta`) above.
				const unusedExportDelta = newIssues.filter(
					(i) => i.type === "export" || i.type === "enumMember",
				);
				if (unusedExportDelta.length > 0) {
					let report =
						"⚠️ Newly unused exports in files you edited — check if callers need updating (Knip):\n";
					for (const issue of unusedExportDelta.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.name}\n`;
					}
					advisoryParts.push(report);
				}
			}
		}
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "knip",
		durationMs: Date.now() - t2,
		metadata: knipMeta,
	});

	// govulncheck — surface session_start-cached Go CVE findings as advisory.
	// No per-turn re-run in this slice; the cache refreshes at next session_start.
	const govCacheEntry = cacheManager.readCache<GovulncheckResult>(
		"govulncheck",
		cwd,
	);
	if (govCacheEntry?.data?.findings?.length) {
		const findings = govCacheEntry.data.findings.slice(0, 5);
		let report =
			"🛡️ Go CVEs reachable from this code (govulncheck) — upgrade where possible:\n";
		for (const f of findings) {
			const callSite = f.trace.find((t) => t.filename);
			const where = callSite?.filename
				? `${toRunnerDisplayPath(cwd, callSite.filename)}${callSite.line ? `:${callSite.line}` : ""}`
				: (f.module ?? f.packageName ?? "(module)");
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			report += `  ${f.osv} (${where})${fix}\n`;
		}
		if (govCacheEntry.data.findings.length > findings.length) {
			report += `  … and ${govCacheEntry.data.findings.length - findings.length} more\n`;
		}
		advisoryParts.push(report);
	}

	const trivyCacheEntry = cacheManager.readCache<TrivyResult>("trivy", cwd);

	// Secrets — UNIFIED surfacing (#131 Mode 3). gitleaks, trivy secret, and the
	// ast-grep hardcoded-secret rules can each flag the SAME line with different
	// rule ids, which the rule-keyed diagnostic dedup can't collapse. Collapse by
	// location so a committed/hardcoded secret is reported ONCE (with combined
	// provenance) — a blocker, since credentials need rotation before merge.
	const gitleaksData = cacheManager.readCache<GitleaksResult>(
		"gitleaks",
		cwd,
	)?.data;
	// #1461 slice 1 (#1460): the gitleaks cache is TTL-only, so a finding for a
	// file deleted after the scan is still served as a 🔴 blocker for the rest
	// of the 30-minute window — the live case, and 119 of 126 findings in
	// pi-lens's own cache. This read is the single agent-facing consumer of that
	// store (session_start's read only decides whether to re-scan; the
	// project-diagnostics path re-scans fresh and reconciles at load), so the
	// drop belongs here, before the findings enter the shared secret pipeline.
	// gitleaks only in this slice — trivy secrets are slice 1's sibling store.
	const gitleaksFindings = dropFindingsForMissingPaths({
		store: "gitleaks",
		findings: gitleaksData?.findings ?? [],
		cwd,
		citedPath: (finding) => finding.file,
	});
	const astSecretWarnings = runtime
		.peekActionableWarnings()
		.filter(isSecretWarning);
	const sessionSecrets = dedupeSecretFindings([
		...fromGitleaks(gitleaksFindings),
		...fromTrivySecrets(trivyCacheEntry?.data?.secrets ?? []),
	]);
	// Locations already surfaced as session-scan secret blockers — used to enrich
	// provenance where ast-grep agrees and to suppress the duplicate ast-grep copy
	// from the actionable-warnings advisory below.
	const secretBlockedLocations = new Set(
		sessionSecrets.map((f) => secretLocationKey(f.file, f.line)),
	);
	if (sessionSecrets.length) {
		// Fold in ast-grep provenance ONLY where it coincides with a session
		// secret — don't promote ast-grep-only findings out of their advisory tier.
		const enriched = dedupeSecretFindings([
			...sessionSecrets,
			...fromAstGrepWarnings(astSecretWarnings).filter((a) =>
				secretBlockedLocations.has(secretLocationKey(a.file, a.line)),
			),
		]);
		const shown = enriched.slice(0, 5);
		let report =
			"🔴 STOP — hardcoded secrets detected. Rotate the credentials and remove them from source:\n";
		for (const f of shown) {
			const where = `${toRunnerDisplayPath(cwd, f.file)}:${f.line}`;
			report += `  ${where} — ${f.rule} [${f.sources.join(" + ")}]${f.description ? `: ${f.description}` : ""}\n`;
		}
		if (enriched.length > shown.length) {
			report += `  … and ${enriched.length - shown.length} more\n`;
		}
		blockerParts.push(report);
	}

	// trivy — surface session_start-cached dependency CVEs (#131, Phase 1).
	// CRITICAL is a blocker (a known-exploitable CVE in a shipped dep is real
	// production risk); HIGH/MEDIUM/LOW are advisory. The agent gets the upgrade
	// target as a hint and decides — we never auto-edit lockfiles.
	if (trivyCacheEntry?.data?.findings?.length) {
		const all = trivyCacheEntry.data.findings;
		const critical = all.filter((f) => f.severity === "CRITICAL");
		const advisory = all.filter((f) => f.severity !== "CRITICAL");
		const fmt = (f: TrivyResult["findings"][number]): string => {
			const pkg = f.installedVersion
				? `${f.pkgName}@${f.installedVersion}`
				: f.pkgName;
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			return `  ${f.vulnerabilityId} (${pkg})${fix}\n`;
		};
		if (critical.length) {
			const shown = critical.slice(0, 5);
			let report =
				"🔴 STOP — CRITICAL dependency CVEs (trivy). Upgrade before shipping:\n";
			for (const f of shown) report += fmt(f);
			if (critical.length > shown.length) {
				report += `  … and ${critical.length - shown.length} more\n`;
			}
			blockerParts.push(report);
		}
		if (advisory.length) {
			const shown = advisory.slice(0, 5);
			let report = "🛡️ Dependency CVEs (trivy) — upgrade where possible:\n";
			for (const f of shown) report += fmt(f);
			if (advisory.length > shown.length) {
				report += `  … and ${advisory.length - shown.length} more\n`;
			}
			advisoryParts.push(report);
		}
	}

	// trivy — dependency license risk (#131 Mode 4). Advisory only: a copyleft /
	// restricted license in a proprietary tree is a compliance signal, not a
	// build break. Surfaced from the same cached `trivy fs` pass.
	const licenses = trivyCacheEntry?.data?.licenses ?? [];
	if (licenses.length) {
		const shown = licenses.slice(0, 5);
		let report =
			"📜 Dependency license risk (trivy) — review for compliance:\n";
		for (const l of shown) {
			const cat = l.category ? `, ${l.category}` : "";
			report += `  ${l.pkgName} — ${l.license} (${l.severity}${cat})\n`;
		}
		if (licenses.length > shown.length) {
			report += `  … and ${licenses.length - shown.length} more\n`;
		}
		advisoryParts.push(report);
	}

	const t3 = Date.now();
	let madgeStats: MadgeBatchStats | undefined;
	if (await depChecker.ensureAvailable()) {
		const madgeFiles = cacheManager.getFilesForMadge(cwd);
		if (madgeFiles.length > 0) {
			dbg(
				`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
			);
			// Checked concurrently (bounded) rather than one `await` per file —
			// the shared circular-dep state update is deferred/folded inside
			// checkFilesBatch so concurrent spawns can't clobber each other (#766).
			const absFiles = madgeFiles.map((file) => path.resolve(cwd, file));
			const batch = await depChecker.checkFilesBatch(absFiles, cwd);
			const depResults = batch.results;
			madgeStats = batch.stats;
			for (const file of madgeFiles) {
				const absPath = path.resolve(cwd, file);
				const depResult = depResults.get(absPath);
				if (!depResult) continue;
				if (depResult.localSkips && depResult.localSkips > 0) {
					// Not silent: a skipped LOCAL import means madge couldn't resolve
					// it into the graph, so a cycle through it would be missed.
					dbg(
						`turn_end: madge skipped ${depResult.localSkips} local file(s) resolving ${file} — possible silent cycle-miss`,
					);
				}
				if (depResult.hasCircular && depResult.circular.length > 0) {
					// Whole-project circular deps are surfaced in lens_diagnostics via the
					// session-start `madge` cache + extractor; this per-file turn-end pass
					// only logs (blockers-only mode suppresses circular-dep notes).
					dbg(
						`turn_end: circular dependency note for ${file} (suppressed in blockers-only mode)`,
					);
				}
			}
		}
	}

	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "madge",
		durationMs: Date.now() - t3,
		...(madgeStats && { metadata: madgeStats }),
	});

	// --- Test runner: fire once per turn after all edits are done ---
	// Runs for each unique test target across modified files; results appear
	// in the next turn's context injection alongside jscpd/madge findings.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		const targets: NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>[] = [];

		// #628: also target the test companions of this turn's cascade neighbors
		// (files that import an edited file) — a neighbor's own tests can break
		// even though the neighbor's source wasn't touched. Reuses `cascadeResults`,
		// already computed above (from the same #450 deferred-cascade drain) for the
		// LSP cascade-diagnostics merge — no second reverse-dependency walk, and the
		// neighbor set inherits whatever budget the cascade compute already applied
		// (CASCADE_NEIGHBOUR_BUDGET), so this can't turn into unbounded per-edit work.
		const candidates: Array<{ display: string; abs: string; isNeighbor: boolean }> =
			[];
		const seenCandidateKeys = new Set<string>();
		for (const file of files) {
			const abs = resolveRunnerPath(cwd, file);
			const key = normalizeMapKey(abs);
			if (seenCandidateKeys.has(key)) continue;
			seenCandidateKeys.add(key);
			candidates.push({ display: file, abs, isNeighbor: false });
		}
		for (const result of cascadeResults) {
			for (const neighbor of result.neighbors) {
				const abs = path.isAbsolute(neighbor.filePath)
					? neighbor.filePath
					: resolveRunnerPath(cwd, neighbor.filePath);
				const key = normalizeMapKey(abs);
				if (seenCandidateKeys.has(key)) continue;
				seenCandidateKeys.add(key);
				candidates.push({ display: neighbor.filePath, abs, isNeighbor: true });
			}
		}

		for (const { display, abs, isNeighbor } of candidates) {
			const target = testRunnerClient.getTestRunTarget(abs, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				targets.push(target);
				dbg(
					`turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
				);
			} else if (!target) {
				dbg(
					`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`,
				);
			}
		}
		if (targets.length > 0) {
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking)`,
			);
			const firedAtTurn = runtime.turnIndex;
			const firedSessionId = runtime.telemetrySessionId;
			const priorTestCache = cacheManager.readCache<TestRunnerFindingsCache>(
				"test-runner-findings",
				cwd,
			)?.data;
			const testRunGeneration = (priorTestCache?.testRunGeneration ?? 0) + 1;
			const provenanceFiles = [
				...candidates.map((candidate) => ({ path: candidate.abs, role: "source" as const })),
				...targets.map((target) => ({ path: target.testFile, role: "test" as const })),
			];
			const launchedFrom = snapshotAdvisoryProvenance({
				cwd,
				runtime,
				generation: testRunGeneration,
				files: provenanceFiles,
			});
			cacheManager.writeCache(
				"test-runner-findings",
				{ ...(priorTestCache ?? { content: "" }), testRunGeneration },
				cwd,
			);
			Promise.allSettled(
				targets.map((t) =>
					testRunnerClient.runTestFileAsync(
						t.testFile,
						cwd,
						t.runner,
						t.config,
					),
				),
			)
				.then((results) => {
					const publishedAgainst = snapshotAdvisoryProvenance({
						cwd,
						runtime,
						generation: testRunGeneration,
						files: provenanceFiles,
					});
					const superseded = launchedFrom.revision.sessionId !== publishedAgainst.revision.sessionId ||
						launchedFrom.revision.projectSeq !== publishedAgainst.revision.projectSeq ||
						launchedFrom.revision.turnIndex !== publishedAgainst.revision.turnIndex ||
						launchedFrom.files.some((file, index) =>
							publishedAgainst.files[index]?.sha256 !== file.sha256 ||
							publishedAgainst.files[index]?.path !== file.path
						);
					// #628: the turn advancing while tests ran no longer means the
					// results are thrown away — a late result is still real
					// information about what's currently broken. It's tagged `stale`
					// so a downstream consumer can distinguish it from a result that
					// arrived in time, but it's cached either way.
					const stale = runtime.turnIndex !== firedAtTurn;
					const failures: string[] = [];
					const resultValues: TestResult[] = [];
					for (const r of results) {
						if (r.status === "rejected") {
							dbg(`turn_end: test run rejected — ${r.reason}`);
							continue;
						}
						resultValues.push(r.value);
						const { file, runner, passed, failed, duration, error } = r.value;
						const shortFile = path.basename(file);
						const summary =
							error && passed === 0 && failed === 0
								? `error: ${error}`
								// #1479: `(0ms)` read as a measurement of zero for a run
								// that was never timed. `formatRunDurationMs` prints
								// `(unmeasured)` for the absent case instead.
								: `${failed > 0 ? "FAIL" : "PASS"} ${passed}p/${failed}f (${formatRunDurationMs(duration)})`;
						dbg(
							`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`,
						);
						if (failed > 0) {
							const formatted = testRunnerClient.formatResult(r.value);
							if (formatted) failures.push(formatted);
						}
					}
					if (failures.length > 0) {
						const currentGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
							"test-runner-findings",
							cwd,
						)?.data?.testRunGeneration;
						if (currentGeneration !== undefined && currentGeneration > testRunGeneration) {
							dbg(`turn_end: test generation ${testRunGeneration} superseded by ${currentGeneration}`);
							return;
						}
						const content = stale
							? `[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]\n\n${failures.join("\n\n")}`
							: failures.join("\n\n");
						cacheManager.writeCache(
							"test-runner-findings",
							{
								content,
								stale,
								results: resultValues,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
							},
							cwd,
						);
						if (getFlag("lens-guard") && firedSessionId === runtime.telemetrySessionId) {
							clearGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								resultValues
									.filter((value) => value.failed === 0)
									.map((value) => value.file),
							);
							mergeGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								content,
								resultValues
									.filter((value) => value.failed > 0)
									.map((value) => value.file),
							);
						}
						dbg(
							`turn_end: ${failures.length} test failure(s) cached for next context injection${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					} else if (results.length > 0) {
						if (getFlag("lens-guard") && firedSessionId === runtime.telemetrySessionId) {
							clearGitGuardTestFailure(cacheManager, cwd, runtime, resultValues.map((value) => value.file));
						}
						dbg(
							`turn_end: all tests passed${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					}
				})
				.catch(() => {});
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	// Session summaries are intentionally suppressed at turn_end to avoid
	// distracting the agent with non-blocking telemetry.

	// Call-graph impact analysis — surface WillBreak/MayBreak callers for modified
	// symbols. MUST run BEFORE the writeProjectDiagnosticsDeltaReport serialization
	// below: it is a delta contributor (like knip above), pushing into
	// projectDiagnosticsDelta / projectDiagnosticsSources. If it ran after the
	// single write, a call-graph-only turn would persist nothing and a mixed turn
	// would drop the call-graph entries — so lens_diagnostics (which only reads the
	// persisted report) would never surface the findings (#179/#533).
	if (runtime.callGraph && files.length > 0) {
		const coverage = runtime.callGraph.coverage;
		if (!coverage || coverage.complete !== true) {
			// An incomplete graph can still contain useful edges, but emitting them
			// as ordinary impact findings would turn unsupported/partial extraction
			// into an authoritative-looking clean result for the rest of the file.
			// Keep the limitation visible and require a complete graph for this
			// user-facing impact surface (#1070).
			advisoryParts.push(
				"Call-graph impact was not emitted because call-graph extraction coverage is incomplete; " +
					"the affected files may have unreported callers.",
			);
		} else {
			try {
				const { impact, formatImpact, parseSymbolKey } = await import("./call-graph.js");
				const { callGraphImpactToProjectDiagnostics } = await import(
					"./project-diagnostics/runner-adapters/call-graph-impact.js"
				);
			const impactLines: string[] = [];
			const impactFindings: { calleeKey: string; results: ReturnType<typeof impact> }[] =
				[];
			for (const filePath of files.slice(0, 5)) {
				// Turn-state files may be cwd-relative while graph keys are absolute,
				// and persisted graphs can contain either slash style/casing. Compare
				// through the shared normalized path seam; keep the original filePath
				// only for display and diagnostics.
				const changedFileKey = normalizeMapKey(resolveRunnerPath(cwd, filePath));
				const fileCallerKeys = [...runtime.callGraph.callers.keys()].filter((k) => {
					const graphFilePath = parseSymbolKey(k).filePath;
					return normalizeMapKey(resolveRunnerPath(cwd, graphFilePath)) === changedFileKey;
				});
				for (const calleeKey of fileCallerKeys.slice(0, 3)) {
					// #1080: drop KNOWN test-role callers BEFORE both the human advisory
					// (formatImpact below) and the persisted delta (impactFindings →
					// callGraphImpactToProjectDiagnostics) — the advisory is rendered
					// first, so the filter must reach the shared `results` set that feeds
					// both. A test caller supplied by an old/fixture/expanded graph must
					// appear in neither surface. Fail-open: an unparseable/unclassifiable
					// key is retained (the adapter re-applies the same predicate).
					const results = impact(runtime.callGraph, calleeKey).filter((r) => {
						const callerFile = parseSymbolKey(r.symbolKey).filePath;
						return (
							!callerFile ||
							!isTestRoleCollateral(resolveRunnerPath(cwd, callerFile))
						);
					});
					if (results.length > 0) {
						impactFindings.push({ calleeKey, results });
						const summary = formatImpact(results, cwd);
						if (summary)
							impactLines.push(`  ${parseSymbolKey(calleeKey).symbolName ?? calleeKey}: ${summary}`);
					}
				}
			}
			if (impactLines.length > 0) {
				advisoryParts.push(
					`📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`,
				);
			}
			if (impactFindings.length > 0) {
				const impactDiagnostics = callGraphImpactToProjectDiagnostics(
					cwd,
					impactFindings,
				);
				if (impactDiagnostics.length > 0) {
					projectDiagnosticsDelta.push(...impactDiagnostics);
					projectDiagnosticsSources.add("call-graph");
				}
			}
			// Non-fatal — call graph is best-effort
		} catch {
			// Non-fatal — call graph is best-effort
		}
		}
	}

	if (projectDiagnosticsDelta.length > 0) {
		writeProjectDiagnosticsDeltaReport(cwd, {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			generatedAt: new Date().toISOString(),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			diagnostics: projectDiagnosticsDelta,
			sources: [...projectDiagnosticsSources].sort((a, b) =>
				a.localeCompare(b),
			),
		});
	}

	const t4 = Date.now();
	const modifiedRangesByFile = new Map(
		Object.entries(turnState.files).map(([file, state]) => [
			normalizeMapKey(resolveRunnerPath(cwd, file)),
			state.modifiedRanges,
		]),
	);
	const getFileSeq = (runtime as Partial<RuntimeCoordinator>).getFileSeq;
	const fileSeqByPath = new Map<string, number>();
	if (getFileSeq) {
		for (const file of files) {
			const filePath = normalizeMapKey(resolveRunnerPath(cwd, file));
			fileSeqByPath.set(filePath, getFileSeq.call(runtime, filePath));
		}
	}
	if (getFlag("lens-actionable-warnings")) {
		try {
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				files,
				modifiedRangesByFile,
				// Suppress the ast-grep secret advisory at any location already
				// surfaced in the unified secrets blocker above (#131 Mode 3) — the
				// secret is reported once, not twice.
				dispatchWarnings: runtime
					.peekActionableWarnings()
					.filter(
						(w) =>
							!(
								isSecretWarning(w) &&
								typeof w.line === "number" &&
								secretBlockedLocations.has(
									secretLocationKey(w.filePath, w.line),
								)
							),
					),
				includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				deltaOnly: !getFlag("lens-actionable-warning-all"),
				dbg,
			});
			writeActionableWarningsReport(cacheManager, cwd, report);
			appendActionableWarningsHistory(cwd, report);
			const advisory = formatActionableWarningsAdvisory(report);
			if (advisory) advisoryParts.push(advisory);
			logActionableWarningsEvent({
				event: advisory ? "advisory_injected" : "advisory_skipped",
				sessionId: runtime.telemetrySessionId,
				metadata: {
					turnIndex: runtime.turnIndex,
					unsuppressed: report.summary.unsuppressed,
				},
			});
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: report.summary,
			});
		} catch (err) {
			dbg(`turn_end: actionable warning report failed: ${err}`);
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: {
					failed: true,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	const t5 = Date.now();
	try {
		const qualityReport = buildCodeQualityWarningsReport({
			cwd,
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			warnings: runtime.peekCodeQualityWarnings(),
			modifiedRangesByFile,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			fileSeqByPath,
		});
		writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
		appendCodeQualityWarningsHistory(cwd, qualityReport);
		const advisory = formatCodeQualityWarningsAdvisory(qualityReport);
		if (advisory) advisoryParts.push(advisory);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: qualityReport.summary,
		});
	} catch (err) {
		dbg(`turn_end: code quality warning report failed: ${err}`);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: {
				failed: true,
				error: err instanceof Error ? err.message : String(err),
			},
		});
	}

	// Cross-file dead-code (#127): surface the cached session_start scan as an
	// advisory (project-wide unused symbols are slow to compute, so we read the
	// cache rather than re-scanning every turn — the analogue of knip's cache
	// for non-JS/TS languages). Merged across languages for polyglot repos.
	try {
		const deadCodeResults: DeadCodeResult[] = [];
		for (const client of deadCodeClients) {
			if (!client.detect(cwd)) continue;
			const cached = cacheManager.readCache<DeadCodeResult>(
				`dead-code-${client.id}`,
				cwd,
			);
			if (cached?.data) deadCodeResults.push(cached.data);
		}
		const advisory = formatDeadCodeAdvisory(deadCodeResults);
		if (advisory) advisoryParts.push(advisory);
	} catch (err) {
		dbg(`turn_end: dead-code advisory failed: ${err}`);
	}

	cacheManager.incrementTurnCycle(cwd, currentOwner);

	const labeledAdvisoryParts = advisoryParts.map(
		(p) => `ℹ️ Advisory — no action required this turn:\n${p}`,
	);
	const findingParts = [...blockerParts, ...labeledAdvisoryParts];
	if (findingParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
		);
		const content = capTurnEndMessage(findingParts.join("\n\n"));
		const signature = `${files
			.slice()
			.sort((a, b) => a.localeCompare(b))
			.join("|")}::${content}`;
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", cwd);
		if (
			last?.data?.signature === signature &&
			last?.data?.sessionId === runtime.telemetrySessionId
		) {
			dbg(
				"turn_end: duplicate findings detected (same session), suppressing re-prompt",
			);
			if (getFlag("lens-guard")) {
				const existingGuard = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
					"turn-end-findings",
					cwd,
				)?.data;
				if (existingGuard) {
					writeGitGuardRecord(cacheManager, runtime, cwd, {
						...(existingGuard as TurnEndFindingsCache),
						content,
						blockerContent: blockerParts.length > 0
							? capTurnEndMessage(blockerParts.join("\n\n"))
							: undefined,
						hasBlockers: blockerParts.length > 0 || existingGuard.testFailures === true,
						blockingFiles: blockerParts.length > 0 ? existingGuard.affectedFiles : undefined,
						projectSeqStart: runtime.turnStartProjectSeq,
						projectSeqEnd: runtime.projectSeq,
						fileSeqByPath: Object.fromEntries(
								runtime.getFileSeqEntries().map(([filePath, seq]) => [normalizeMapKey(path.resolve(filePath)), seq]),
						),
						fileContentHashes: {},
						consumed: false,
					});
				}
			}
			cacheManager.clearTurnState(cwd, currentOwner);
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
		const fileSeqByPath: Record<string, number> = {};
		for (const [filePath, seq] of runtime.getFileSeqEntries()) {
			fileSeqByPath[normalizeMapKey(path.resolve(filePath))] = seq;
		}
		if (getFlag("lens-guard")) {
			const existingGuard = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			const blockingContent = blockerParts.length > 0
				? capTurnEndMessage(blockerParts.join("\n\n"))
				: undefined;
			const affectedFiles = [
				...(existingGuard?.affectedFiles ?? []),
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) =>
					result.neighbors
						.filter((neighbor) => neighbor.diagnostics.length > 0)
						.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
				),
			];
			writeGitGuardRecord(cacheManager, runtime, cwd, {
				content: [content, existingGuard?.testFailureContent]
					.filter((value): value is string => !!value)
					.join("\n\n"),
				blockerContent: blockingContent,
				blockingFiles: blockerParts.length > 0 ? affectedFiles : undefined,
				hasBlockers: !!blockingContent || existingGuard?.testFailures === true,
				affectedFiles,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				fileContentHashes: {},
				consumed: false,
				testFailures: existingGuard?.testFailures,
				testFailureContent: existingGuard?.testFailureContent,
				testFailureFiles: existingGuard?.testFailureFiles,
			});
		} else {
			const allAffectedFiles = [
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) => result.neighbors
					.filter((neighbor) => neighbor.diagnostics.length > 0)
					.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath))),
			];
			const affectedFiles = [...new Set(allAffectedFiles)]
				.slice(0, MAX_ADVISORY_AFFECTED_FILES);
			const affectedFilesTruncated = new Set(allAffectedFiles).size > affectedFiles.length;
			cacheManager.writeCache("turn-end-findings", {
				content,
				affectedFiles,
				affectedFilesTruncated,
				provenance: snapshotAdvisoryProvenance({
					cwd,
					runtime,
					generation: 0,
					files: affectedFiles.map((file) => ({ path: file, role: "affected" as const })),
					truncated: affectedFilesTruncated,
				}),
			}, cwd);
		}
		cacheManager.writeCache(
			"turn-end-findings-last",
			{
				signature,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
			},
			cwd,
		);
		emitLensTurnFindings({
			cwd,
			filePaths: files.map((file) => resolveRunnerPath(cwd, file)),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
			content,
		});
	}
	if (blockerParts.length === 0) {
		cacheManager.clearTurnState(cwd, currentOwner);
		if (getFlag("lens-guard") && advisoryParts.length === 0 && !runtime.gitGuardHasBlockers) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
	}

	runtime.fixedThisTurn.clear();
	runtime.clearActionableWarnings();
	runtime.clearCodeQualityWarnings();
	logLatency({
		type: "tool_result",
		toolName: "turn_end",
		filePath: cwd,
		durationMs: Date.now() - turnEndStart,
		result: blockerParts.length > 0 ? "blockers_found" : "clean",
		metadata: {
			fileCount: files.length,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
		},
	});
	resetFormatService();
}
