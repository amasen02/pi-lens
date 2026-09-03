/**
 * #2523 AC1: no NEW unbounded `await` on a pi hook path, and no NEW
 * hand-rolled timeout race anywhere in the shipped tree.
 *
 * ## The defect this guards
 *
 * `wrapSessionEventHandler` (`clients/session-event-guard.ts`) absorbs a
 * stale-ctx throw and adds NO deadline and NO abort. Every bound in the
 * codebase lived at a LEAF — a spawn timeout, an LSP wait — so a dependency
 * that wedged BEFORE reaching the leaf was unreachable by all of them.
 * #2523's probes against the real handlers measured the consequence: a wedged
 * dependency on `turn_end` never returned (400 000 ms harness ceiling), and
 * with the ambient abort fired at t=2 s exactly as `index.ts` wires it,
 * `still-blocked after 30011ms` — Escape does not release the hook.
 *
 * `bounded()` (`clients/deadline-utils.ts`) is the fix primitive: it takes
 * BOTH bounds and its type refuses one without the other. This sweep is what
 * makes the primitive load-bearing rather than optional.
 *
 * ## Two families, one table
 *
 * 1. **`hook-await`** — every `await` in `index.ts`, `clients/runtime-*.ts`,
 *    `mcp/server.ts` and `clients/mcp/session.ts`, the four places a
 *    registered hook handler and its direct deps live. Wrapped in
 *    `bounded()`, or written down here.
 * 2. **`hand-rolled-race`** — every `Promise.race([...])` whose own arms
 *    include a `setTimeout` or an `AbortSignal.timeout`, anywhere in
 *    `clients/`, `index.ts`, `mcp/` or `tools/`, outside `deadline-utils.ts`
 *    itself. `bounded()` must become THE one bound primitive rather than a
 *    new sibling of the scattered idioms, so a NEW hand-rolled race is
 *    forbidden from today even though the existing ones are not migrated in
 *    this slice.
 *
 * ## Why the await scan over-includes, deliberately
 *
 * Not every `await` in those four groups is hook-reachable: a slash command
 * in `index.ts` and an MCP tool-request handler in `mcp/server.ts` are not. A
 * real reachability walk was considered and rejected for slice 1.
 * `tests/support/session-state-scan.ts` already documents why an unrestricted
 * call-graph walk answers a different question ("walking EVERY call out of
 * `handleSessionStart` would drag in most of the codebase"), and a walk that
 * follows only SOME edges — bare calls but not methods, not callbacks, not
 * dynamic imports — produces false NEGATIVES, which for a guard is the
 * direction that fails silently.
 *
 * So the scan over-includes and the table records the judgement. Each entry
 * names WHICH hook's budget the await spends, or says that none applies and
 * why. That is a fact a reviewer can check against the source; a reachability
 * heuristic's silence is not.
 *
 * ## The table is a BASELINE, deliberately
 *
 * Every entry below is today's tree, owned by `#2523 slice 2` — the slice
 * that actually bounds these awaits and folds the hand-rolled races into
 * `bounded()` (AC3-AC8). Slice 1 changes no hook's behavior. The value
 * shipped here is the RATCHET: entry N+1 cannot be added silently. #2523 says
 * it in as many words — "slice 1's red output is the worklist".
 *
 * Keys are content-derived, never line numbers (#2487): a line inserted
 * elsewhere in `index.ts` must not re-key 29 exemptions, and a textual merge
 * of two such re-keys can land a WRONG number with no conflict marker. The
 * shape is `stableOccurrenceKey`'s (`path#enclosingSymbol:contentHash`); see
 * {@link awaitOccurrenceKey} for the one widening this family forced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type HookBudgetKey,
	HOOK_WALL_BUDGET_MS,
	isHookBudgetKey,
} from "../../clients/hook-budgets.js";
import { lineContentHash } from "../../clients/read-guard.js";
import {
	auditRegistry,
	findEnclosingSymbol,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one module allowed to spell a timeout race: the canonical implementation. */
const DEFINITION_FILE = "clients/deadline-utils.ts";

/**
 * Whose budget an unbounded await spends.
 *
 * A {@link HookBudgetKey} is the load-bearing case: it asserts the await runs
 * under that hook, and the assertion is checked — every value here must be a
 * key of `HOOK_WALL_BUDGET_MS`, so a renamed hook family breaks this table
 * instead of leaving it quietly wrong.
 *
 * The two non-hook cases are stated rather than smuggled in as an invented
 * budget:
 * - `"off-hook"` — not reachable from any registered hook handler at all: a
 *   slash-command body, an MCP tool-REQUEST handler, a CLI entry point. The
 *   await scan over-includes on purpose (see the header); this is where that
 *   shows. Every `hand-rolled-race` entry is `off-hook` unless the race sits
 *   on a hook path.
 * - `"unbudgeted-hook"` — reachable from a registered hook that #2523's
 *   contract gives no wall budget (`tool_call`, `resources_discover`,
 *   `message_end`). Recorded as a gap, not papered over with a number nobody
 *   agreed to.
 */
type AwaitSite = HookBudgetKey | "off-hook" | "unbudgeted-hook";

interface SweepExemption {
	/** Which scan flagged it. */
	family: "hook-await" | "hand-rolled-race";
	/** Which hook's budget it spends. */
	site: AwaitSite;
	/** Why it is still unbounded. Checked for length by `auditRegistry`. */
	reason: string;
	/** The issue that owns closing it. */
	owner: string;
}

/**
 * Known imprecision, stated rather than hidden — the
 * `SWEEP_HEURISTIC_LIMITS` convention from
 * `tests/support/session-state-scan.ts`.
 */
export const SWEEP_HEURISTIC_LIMITS = [
	"Line-granular, not expression-granular. A line carrying two awaits is ONE " +
		"flagged occurrence, and it counts as bounded only if EVERY await on it " +
		"is (the strict direction: `await bounded(a) + await raw()` stays red).",
	"No reachability walk. Every await in the four scanned file groups is a " +
		"candidate; whether a site is actually on a hook path is recorded in the " +
		"exemption table's `site` field, which a reviewer checks against the " +
		"source. Over-inclusion is the safe direction for a guard.",
	"`bounded()` is recognised SYNTACTICALLY, by call shape. A helper that " +
		"wraps `bounded()` one level down reads as unbounded here and needs an " +
		"exemption naming the wrapper — mechanically visible, unlike a walk that " +
		"would silently call it clean.",
	"A `withDeadline`/`withTimeout`/`withBudget`/`withinRemaining` call counts " +
		"as bounded ONLY when the word `signal` appears inside its own " +
		"parentheses. Those helpers take no signal today, so this is forward " +
		"cover for a signal-aware caller, not a claim about the helpers.",
	"Awaits in `clients/` modules OTHER than `runtime-*.ts` are out of scope of " +
		"the hook-await family, so a hook whose work moves into a new helper " +
		"module leaves that scan's view. #2523 slice 2 threads the hook signal " +
		"into the deps types, which is the structural answer; this sweep covers " +
		"the hook FILES.",
	"The hand-rolled-race scan reads the race's own parentheses PLUS the 25 " +
		"lines above it, because the dominant spelling hoists the timer arm into " +
		"a named local. A timer built further away, in a helper, or in another " +
		"module is invisible to it; a `setTimeout` within 25 lines of an " +
		"unrelated race is a false positive, which is a table entry rather than " +
		"a silent hole. A bare `new Promise` + `setTimeout` with no race at all " +
		"is a delay, not a bound, and is not flagged.",
	"Comments and string literals are blanked first (`stripSource`), so an " +
		"`await` or a `Promise.race` named in prose or inside a string is not a " +
		"call.",
] as const;

/**
 * {@link occurrenceKeys} output -> the judgement about that exact occurrence.
 *
 * When a genuine edit to a flagged line invalidates a key (not a line
 * inserted elsewhere — that churn is what content keying removes), the
 * failing test prints the key the scan now computes; paste it in with a
 * reason, or wrap the call in `bounded()` and delete the entry.
 */
const EXEMPT_SITES: Readonly<Record<string, SweepExemption>> = {
	"clients/mcp/session.ts#getMcpSessionContext:9e621631": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (#2523 AC8): `getMcpSessionContext` awaits the " +
			"analyzer bootstrap that both `runSessionStart` and " +
			"`runTurnEnd` go through. The MCP adapter calls the same " +
			"handlers index.ts does and needs the same bounds.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:c07917b8": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:c91ba2a9": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runSessionStart:ddda6a44": {
		family: "hook-await",
		site: "session_start",
		reason:
			"MCP host parity (AC8): the standalone MCP server's " +
			"session_start entry calls `handleSessionStart` with no " +
			"deadline and no signal, exactly like index.ts:2151.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndNow:fd351abe": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): `runTurnEndNow` calls `handleTurnEnd` " +
			"unbounded. `TURN_END_QUEUE_WAIT_MS` bounds ADMISSION to the " +
			"queue, not the work it admits — #2523 says so explicitly.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndNow:9b095eed": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): `runTurnEndNow` calls `handleTurnEnd` " +
			"unbounded. `TURN_END_QUEUE_WAIT_MS` bounds ADMISSION to the " +
			"queue, not the work it admits — #2523 says so explicitly.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEnd:fc8802c2": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the queued `runTurnEnd` wrapper awaits " +
			"`runTurnEndNow`; the queue's wait bound is an admission bound, " +
			"not a work bound.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndForIpcNow:b91fc98b": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the IPC turn-end entry reached from " +
			"mcp/server.ts's socket handler; the same unbounded " +
			"`handleTurnEnd` sits beneath it.",
		owner: "#2523 slice 2",
	},
	"clients/mcp/session.ts#runTurnEndForIpcNow:94dcc34c": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP host parity (AC8): the IPC turn-end entry reached from " +
			"mcp/server.ts's socket handler; the same unbounded " +
			"`handleTurnEnd` sits beneath it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#handleAgentEnd:7845e23f": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`getAutofixClients()` -> `loadBootstrapClients()` — #2523 " +
			"names this exact site (runtime-agent-end.ts:347) as " +
			"agent_settled's unbounded analyzer bootstrap.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#handleAgentEnd:536200a6": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runAutofix` on the deferred drain: per-runner spawn timeouts " +
			"exist at the leaf, nothing bounds the phase above them.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#d47fdeae": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#47fd72b4": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#5c5f3e00": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"The format phase (`runFormatPhase` per file, joined by " +
			"`Promise.all`) — #2523 AC6's aggregate formatter budget lands " +
			"here. `runFormattersWithConcurrency` is a sequential loop with " +
			"per-item 30s timers, no aggregate cap and no signal in the " +
			"race; the 3-wedged-formatter probe measured `still-blocked " +
			"after 45011ms`.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#15fd504e": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`resyncLspFile` after a deferred write: the LSP touch has its " +
			"own wait bound, the resync above it does not.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#f1522e99": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`resyncLspFile` after a deferred write: the LSP touch has its " +
			"own wait bound, the resync above it does not.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-agent-end.ts#10b7ee8c": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`applyConservativeActionableWarningFixes` — #2523's " +
			"agent_settled list (runtime-agent-end.ts:871): count-capped at " +
			"5 fixes, with no time bound at all.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-coordinator.ts#db8cb9e5": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"The turn-end cascade settle race: bounded at 5000ms with NO " +
			"abort arm — #2523's `bounded but no abort race` list. 5000ms " +
			"alone also exceeds turn_end's whole 3000ms budget.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#demandBootstrapDeps:4b58d42f": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`demandBootstrapDeps` — the analyzer-bootstrap request every " +
			"session_start scan goes through.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#readSequenceWithBudget:2f2e0329": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget`'s race: a real budget with NO abort " +
			"arm. Also flagged by this sweep's hand-rolled-race family, " +
			"which is the fold slice 2 owns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:64c1d126": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:7acb6a28": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteWarmFiles:dcf2191d": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:28a38d8e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:046d7d7e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:a8f31d0f": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:a84591ae": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:b0e11f3d": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:4443bc3e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#igniteDominantLanguageWarm:954da112": {
		family: "hook-await",
		site: "session_start",
		reason:
			"LSP warm ignition on session_start (`igniteWarmFiles` / " +
			"`igniteDominantLanguageWarm`): file collection, dynamic " +
			"imports and per-file `touchFile` calls, none bounded above " +
			"their leaves.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleManagedToolRefresh:6e196ac8": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleManagedToolRefresh:004a75f5": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#probePrettierInstall:6dcf5c48": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Managed-tool refresh and the prettier-install probe, scheduled " +
			"from session_start with no wall bound above the spawn.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:8fb2949e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:cfff2370": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#collectTodoBaselineItems:9d4b3875": {
		family: "hook-await",
		site: "session_start",
		reason:
			"TODO-baseline collection on session_start. `yieldIfOverBudget` " +
			"yields the event loop so the host stays responsive; it does " +
			"not bound how long the scan takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:c0025731": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:5e211766": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:58f7b022": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:fd23bcc1": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#buildOrRefreshWordIndex:29c6e442": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Word-index build/refresh on session_start (#162): a dynamic " +
			"import plus an O(project-files) build. `buildWordIndexAsync` " +
			"yields cooperatively (WORD_INDEX_BUILD_YIELD_BUDGET_MS 8ms) " +
			"but has no total bound.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScans:b0811f9f": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`scheduleStartupScans` / `scheduleStartupScansWithClients`: " +
			"the session_start scan fan-out and its bootstrap-dependency " +
			"resolution.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:e1526246": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`scheduleStartupScans` / `scheduleStartupScansWithClients`: " +
			"the session_start scan fan-out and its bootstrap-dependency " +
			"resolution.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:e68cf867": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:30379879": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:6c23d3d2": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:991b3ce1": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:1ccbe113": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:313ec735": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:5283cc2e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:5c2989dc": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:d38fbbbe": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:eb07b5cd": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:1688c176": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleStartupScansWithClients:4339bb12": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#9a1dbe54": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#28633644": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#8f2996e6": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#c1c3af0d": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#2be35cbe": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#59f5dcb6": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#07b3c4a9": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#a95b9b5e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#ead9f012": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#40a1cab3": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#650273c9": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#2bc7b55e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"One heavyweight startup analyzer per await (knip, jscpd, " +
			"govulncheck, gitleaks, opengrep, madge, trivy, ast-grep, " +
			"review graph, call graph, codebase model, word index). Each " +
			"has a spawn-level timeout at the leaf and none has a wall " +
			"bound above it; together they are session_start's 5000ms " +
			"budget many times over.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleDeferredToolProbes:67dd8399": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Deferred tool probes scheduled from session_start. The go/rust " +
			"availability probes are 3000ms each, sequential, and re-armed " +
			"on every full session_start — #2523's `bounded but no abort " +
			"race` list.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleDeferredToolProbesWithClients:bd40d11e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Deferred tool probes scheduled from session_start. The go/rust " +
			"availability probes are 3000ms each, sequential, and re-armed " +
			"on every full session_start — #2523's `bounded but no abort " +
			"race` list.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#scheduleDeferredToolProbesWithClients:e1a3dff5": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Deferred tool probes scheduled from session_start. The go/rust " +
			"availability probes are 3000ms each, sequential, and re-armed " +
			"on every full session_start — #2523's `bounded but no abort " +
			"race` list.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:975403f3": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:f82ba1cb": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:5bc273b1": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:75cec502": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:8950e7c9": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:c784fcf2": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:dcbdf8ec": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#handleSessionStart:bb646cf5": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart`'s own body: startup-scan context, " +
			"language profile, word index, LSP config load and the two warm " +
			"ignitions, awaited in sequence with no aggregate bound. This " +
			"IS the 5000ms budget's contents.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#445fcc1e": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget` from the sequence fast path (#451): " +
			"the budget is real (250ms default) but carries no abort arm.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#f23f7233": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`readSequenceWithBudget` from the snapshot-root path: same " +
			"real budget, same missing abort arm.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#0825b6c3": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#bfb3d7ca": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-session.ts#39b67a32": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Session-start summary: go and rust availability probes, 3000ms " +
			"each and sequential, re-armed on every full session_start " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCall:b283b2ad": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:069e109f": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:04a10135": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:bf48e7c4": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:4a42a6b3": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#handleToolCallImpl:08f5433d": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#2717940e": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#6dc0475c": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#dde2371c": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"`requestBootstrapClients` passing `getAmbientAbortSignal()` — " +
			"#2523 AC4's dead-signal site: `setAmbientAbortSignal` is only " +
			"ever called from tool_result, so the signal read here is " +
			"ALWAYS undefined. Fixing it is AC4's job, not slice 1's.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#e4c60d3b": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#a88f3c5a": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#d2ea9ac8": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#da2111d4": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-call.ts#88da04a5": {
		family: "hook-await",
		site: "unbudgeted-hook",
		reason:
			"On the `tool_call` path. #2523's contract table declares no " +
			"wall budget for tool_call, so this await has no number to be " +
			"measured against yet; recorded as the gap rather than assigned " +
			"an invented one.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#flushDebouncedToolResults:9dad9d82": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"`flushDebouncedToolResults` joins every debounced pipeline " +
			"with `Promise.all` and no aggregate bound. It is awaited from " +
			"agent_end (index.ts:2670) and turn_end (index.ts:2872) as " +
			"well, so its cost lands in three budgets.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#dispatchPipelineAnalysis:09ae48d6": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"`dispatchPipelineAnalysis` awaits the pipeline promise. Runner " +
			"timeouts are per-runner leaves (RUNNER_TIMEOUT_MS 30000), " +
			"which is 3x the edit budget on its own.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:9795f1d1": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:8fbbfc33": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#handleToolResult:231f7fdd": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"The edit tool_result body — the ONE path #2523's contract " +
			"allows to block the host, and only for 10000ms. Measured write " +
			"p90 2614ms / edit p90 3199ms today, so the budget is a ceiling " +
			"rather than a change.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#5a6068e3": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#572e10ea": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#7947596d": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Observed-mutation settle and dispatch on the edit path. " +
			"`OBSERVED_TURN_BUDGET_MS` (600ms) bounds the CAPTURE, not this " +
			"join.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#1b32658a": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Classified-mutation join and the second dispatch on the edit " +
			"path; same leaf-bounded, aggregate-unbounded shape as the " +
			"observed path above.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-tool-result.ts#30165e9b": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"Classified-mutation join and the second dispatch on the edit " +
			"path; same leaf-bounded, aggregate-unbounded shape as the " +
			"observed path above.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#runTestTargetsBounded:fa32085f": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`runTestTargetsBounded`'s per-target loop. Its batch budget " +
			"(TEST_RUNNER_BATCH_BUDGET_MS, 90000ms) is 30x turn_end's " +
			"total; test-runner delivery already has an off-hook channel " +
			"(#2366) and #2522 owns selection.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#runTestTargetsBounded:66150fd7": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`runTestTargetsBounded`'s per-target loop. Its batch budget " +
			"(TEST_RUNNER_BATCH_BUDGET_MS, 90000ms) is 30x turn_end's " +
			"total; test-runner delivery already has an off-hook channel " +
			"(#2366) and #2522 owns selection.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#handleTurnEnd:dcce4853": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`sweepInlineBlockerFreshness` — #2523's turn_end list " +
			"(runtime-turn.ts:789): unconditional, no `signal` parameter, " +
			"uncapped population.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#handleTurnEnd:51bdc300": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`runtime.settleCascadeRuns` — bounded at 5000ms with no abort " +
			"arm, and 5000ms alone exceeds the 3000ms turn_end budget " +
			"(#2523's `bounded but no abort race` list).",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#c1b4b854": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`knipClient.analyze` — #2523's turn_end list " +
			"(runtime-turn.ts:1355): the 30s timeout lives INSIDE the " +
			"spawn, so anything that wedges before the spawn is unreachable " +
			"by it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#82689416": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"A project-diagnostics analyzer run on turn_end with a " +
			"spawn-level timeout only; the same leaf-bound shape as knip " +
			"above it.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#4c2a6d5d": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"madge dependency-check on turn_end behind a flag: " +
			"`ensureAvailable` and the batch check are both unbounded above " +
			"their spawns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#f1a6eead": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"madge dependency-check on turn_end behind a flag: " +
			"`ensureAvailable` and the batch check are both unbounded above " +
			"their spawns.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#b0e0a70c": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"Dynamic import of the call-graph analyzer on the turn_end " +
			"path. Module load is unbounded, and #1974's 31.7s warmup was a " +
			"module-compilation cost of exactly this shape.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#5d26939c": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"Dynamic import of the call-graph analyzer on the turn_end " +
			"path. Module load is unbounded, and #1974's 31.7s warmup was a " +
			"module-compilation cost of exactly this shape.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#5f4f9eeb": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`buildActionableWarningsReport` on turn_end. #2509 moved its " +
			"DELIVERY off-hook (`publishActionableWarningsReport`); the " +
			"build itself still runs inside the hook.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#5d8e1337": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`drainPendingRunnerFindings(0)` — a zero-WAIT drain, which " +
			"bounds how long it waits for new findings but not how long the " +
			"drain itself takes.",
		owner: "#2523 slice 2",
	},
	"clients/runtime-turn.ts#f3a731f9": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`readCachedDiagnosticsForServers` — #2523's turn_end list " +
			"(runtime-turn.ts:2882).",
		owner: "#2523 slice 2",
	},
	"index.ts#ensureLSPConfigInitialized:91e3abf2": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`initLSPConfig` inside `ensureLSPConfigInitialized`, reached " +
			"from session_start (index.ts:2131) and from tool_call. #2523 " +
			"names it in the session_start list of unbounded awaits.",
		owner: "#2523 slice 2",
	},
	"index.ts#76a146a5": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#0198c74b": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#c90021ae": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#149647f6": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#1a86851b": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#cf8d0bf9": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#fbdebf6f": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"Slash-command body (`/lens-*`): the user typed the command and " +
			"is waiting for its answer, so no hook budget applies. Flagged " +
			"only because the await scan covers whole files rather than " +
			"walking reachability.",
		owner: "#2523 slice 2",
	},
	"index.ts#a62eabde": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`configureWarmAttach` — one of the four unbounded " +
			"session_start awaits #2523 names (index.ts:2060).",
		owner: "#2523 slice 2",
	},
	"index.ts#fb5c0802": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`ensureLSPConfigInitialized` — #2523's session_start list " +
			"(index.ts:2131).",
		owner: "#2523 slice 2",
	},
	"index.ts#6b6a17e3": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`handleSessionStart` itself: the entire session_start body " +
			"under one await. Slice 2 bounds it at the registered handler " +
			"with the 5000ms budget; wrapping it here as well would " +
			"double-bound the same work.",
		owner: "#2523 slice 2",
	},
	"index.ts#ed2fa6e1": {
		family: "hook-await",
		site: "session_start",
		reason:
			"Installer `ensureTool` for a managed tool during " +
			"session_start. The spawn has a leaf timeout; the dynamic " +
			"module load and resolution above it have none.",
		owner: "#2523 slice 2",
	},
	"index.ts#8bf17235": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`loadSessionState` — #2523's session_start list " + "(index.ts:2245).",
		owner: "#2523 slice 2",
	},
	"index.ts#28d98950": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`dropStaleFiles` — #2523's session_start list (index.ts:2252): " +
			"up to 1024 concurrent `fs.stat` with no wall bound. On a " +
			"9p/slow filesystem (#462 measured 1.3ms per stat) that is " +
			"seconds of unbounded startup.",
		owner: "#2523 slice 2",
	},
	"index.ts#e1ee0cda": {
		family: "hook-await",
		site: "tool_result_read_only",
		reason:
			"THE read-only offender #2523 AC5 names (index.ts:2381 in the " +
			"issue's tree): `loadBootstrapClients()` is awaited for EVERY " +
			"tool result — Read/Grep/Glob/Bash — with no timeout and no " +
			"signal, before the mutation gate in runtime-tool-result.ts. " +
			"AC5's red-first test is at 500ms.",
		owner: "#2523 slice 2",
	},
	"index.ts#b67b959d": {
		family: "hook-await",
		site: "tool_result_edit",
		reason:
			"`handleToolResult` itself: the whole tool_result body under " +
			"one await. Slice 2 applies the split budget (500ms read-only / " +
			"10000ms edit) at the registered handler, after the mutation " +
			"classification decides which applies.",
		owner: "#2523 slice 2",
	},
	"index.ts#e1d6d377": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"Reached from `onAgentSettled` (index.ts:3137/3143): the " +
			"observed-mutation settled sweep and its ledger refresh. " +
			"agent_settled is the designated place for settled-time work " +
			"and carries the widest non-edit budget (10000ms), but nothing " +
			"enforces it today.",
		owner: "#2523 slice 2",
	},
	"index.ts#92745bf9": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"Reached from `onAgentSettled` (index.ts:3137/3143): the " +
			"observed-mutation settled sweep and its ledger refresh. " +
			"agent_settled is the designated place for settled-time work " +
			"and carries the widest non-edit budget (10000ms), but nothing " +
			"enforces it today.",
		owner: "#2523 slice 2",
	},
	"index.ts#309a8dd5": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runDeferredMutationDrain`, called from `onAgentSettled` " +
			"(index.ts:3138). Its `getAutofixClients` closure is the " +
			"`loadBootstrapClients()` #2523 names under agent_settled; " +
			"runtime-agent-end.ts:347 is the consumer.",
		owner: "#2523 slice 2",
	},
	"index.ts#7b3bb855": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`runDeferredMutationDrain`, called from `onAgentSettled` " +
			"(index.ts:3138). Its `getAutofixClients` closure is the " +
			"`loadBootstrapClients()` #2523 names under agent_settled; " +
			"runtime-agent-end.ts:347 is the consumer.",
		owner: "#2523 slice 2",
	},
	"index.ts#7c987d2d": {
		family: "hook-await",
		site: "agent_end",
		reason:
			"`flushDebouncedToolResults` — #2523's agent_end entry " +
			"(index.ts:2670): it re-enters the full pipeline unbounded, and " +
			"agent_end's measured p90 is 10043ms against a 1000ms budget.",
		owner: "#2523 slice 2",
	},
	"index.ts#3271e0f2": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`flushDebouncedToolResults` on the turn_end path: the same " +
			"unbounded pipeline re-entry as the agent_end copy, under the " +
			"3000ms turn_end budget.",
		owner: "#2523 slice 2",
	},
	"index.ts#00f2b725": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`loadBootstrapClients()` on turn_end — the same analyzer " +
			"bootstrap the read-only tool_result path awaits, with the same " +
			"absence of a timeout and a signal.",
		owner: "#2523 slice 2",
	},
	"index.ts#b7cc50a4": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`handleTurnEnd` itself: the entire turn_end body under one " +
			"await, measured p50 3687ms / p90 14246ms against a 3000ms " +
			"budget. Slice 2 bounds it at the registered handler.",
		owner: "#2523 slice 2",
	},
	"index.ts#aa5913b4": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"index.ts#c371cb35": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"index.ts#794d85e1": {
		family: "hook-await",
		site: "agent_settled",
		reason:
			"`onAgentSettled` awaits its three phases in sequence with no " +
			"aggregate bound; the 10000ms budget is a TOTAL, not a " +
			"per-phase allowance.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#ensureReady:f5db9400": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`ensureLspConfig` inside `ensureReady`, the MCP server's lazy " +
			"init. Reached from the session_start and turn_end IPC entries " +
			"as well as from every tool request (AC8).",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:42cf1413": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:ddd539ea": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#startIpcServer:0b15773d": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"MCP IPC socket handler: `ensureReady` plus `runTurnEndForIpc` " +
			"per inbound turn-end request. This is the MCP mirror of pi's " +
			"turn_end hook (AC8) and carries the same 3000ms contract.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:642ba5ff": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:e3c6bce2": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:78f14371": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:ba32f7fa": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:86bdc3e0": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:70d2cffe": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:b2ed9593": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:5346e898": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:8e08d6a5": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#callTool:e9d63f4e": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#56eabee3": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#4efdc9b8": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#0a1b3291": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#90a7c85f": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#4950a2f0": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#e9dd74d1": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-REQUEST handler (`callTool`): an agent asked a " +
			"pilens_* tool for an answer and is waiting for it. No pi hook " +
			"is involved, so no hook budget applies; the await scan covers " +
			"whole files rather than walking reachability.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#2de9b076": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`pilens_session_start` tool request: the MCP mirror of the " +
			"session_start hook (AC8), unbounded exactly like its index.ts " +
			"twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#2ba33df5": {
		family: "hook-await",
		site: "session_start",
		reason:
			"`pilens_session_start` tool request: the MCP mirror of the " +
			"session_start hook (AC8), unbounded exactly like its index.ts " +
			"twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#805a903f": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`pilens_turn_end` tool request: the MCP mirror of the turn_end " +
			"hook (AC8), unbounded exactly like its index.ts twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#41fc0a05": {
		family: "hook-await",
		site: "turn_end",
		reason:
			"`pilens_turn_end` tool request: the MCP mirror of the turn_end " +
			"hook (AC8), unbounded exactly like its index.ts twin.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#f080928d": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#6c40bfa1": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#29df56a4": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"mcp/server.ts#handleRequest:84579e34": {
		family: "hook-await",
		site: "off-hook",
		reason:
			"MCP tool-request handler (LSP navigation/diagnostics) and the " +
			"request dispatcher itself. An agent is waiting on its own " +
			"request; no pi hook budget applies.",
		owner: "#2523 slice 2",
	},
	"race:clients/bootstrap.ts#awaitWithinBounds:b3c90d49": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Hand-rolled timeout race in the analyzer-bootstrap loader " +
			"(`awaitWithinBounds`). Reached from every hook that needs " +
			"analyzer clients, so folding it into `bounded()` is high-value " +
			"slice-2 work; slice 1 only forbids NEW ones.",
		owner: "#2523 slice 2",
	},
	"race:clients/dispatch/dispatcher.ts#runRunner:6ec034f4": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Per-runner RUNNER_TIMEOUT_MS race (30000ms) with no abort arm " +
			"— 10x turn_end's whole budget at one leaf. Slice 2's fold " +
			"worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/dispatch/integration.ts#76967656": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Cascade-computation race in the dispatch integration layer; a " +
			"hand-rolled timer arm, no abort arm. Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/format-service.ts#FormatService:4fd51bc2": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"#2523 AC6's target: `runFormattersWithConcurrency` is a " +
			"sequential loop with a per-item 30s timer, no aggregate cap " +
			"and no signal in the race (`_concurrency` is unused). The " +
			"3-wedged-formatter probe measured `still-blocked after " +
			"45011ms`.",
		owner: "#2523 slice 2",
	},
	"race:clients/lsp-document-symbols.ts#getOpenDocumentSymbols:03304df0": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"Document-symbol wait race with a hand-rolled timer arm; the " +
			"LSP family's `maxWaitMs` shape. Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/lsp/index.ts#c0ed37b0": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"LSP wait race with a hand-rolled timer arm (the `maxWaitMs` " +
			"family #2523's inventory names). Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/observed-mutation.ts#withBounds:85254221": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"`withBounds`: the observed-mutation capture budget " +
			"(OBSERVED_CAPTURE_BUDGET_MS) as a hand-rolled race. Slice 2's " +
			"fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/pipeline.ts#resyncLspFile:f118dc91": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"`resyncLspFile`'s touch-versus-bail race with a hand-rolled " +
			"timer arm. Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/quiet-window.ts#buildHeartbeatResourcePatchBounded:4f9a4e19": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"`buildHeartbeatResourcePatchBounded`'s hand-rolled race — " +
			"already named `Bounded`, which is exactly why it should be " +
			"spelled with the shared primitive. Slice 2's fold worklist.",
		owner: "#2523 slice 2",
	},
	"race:clients/runtime-coordinator.ts#db8cb9e5": {
		family: "hand-rolled-race",
		site: "turn_end",
		reason:
			"The turn-end cascade settle race (5000ms, no abort arm) as a " +
			"hand-rolled race. Its await is separately exempted in the " +
			"hook-await family; both entries close together in slice 2.",
		owner: "#2523 slice 2",
	},
	"race:clients/runtime-session.ts#readSequenceWithBudget:2f2e0329": {
		family: "hand-rolled-race",
		site: "session_start",
		reason:
			"`readSequenceWithBudget`'s hand-rolled race on the " +
			"session_start sequence fast path (#451). Its awaits are " +
			"separately exempted in the hook-await family.",
		owner: "#2523 slice 2",
	},
	"race:mcp/analyze-cli.ts#readHookPayload:dc1b776a": {
		family: "hand-rolled-race",
		site: "off-hook",
		reason:
			"`readHookPayload`'s stdin-read race in the analyze CLI: a " +
			"standalone process entry point, no pi hook involved. Slice 2's " +
			"fold worklist for uniformity, not for a hook budget.",
		owner: "#2523 slice 2",
	},
};

/** The four file groups a registered hook handler and its direct deps live in. */
function hookPathFiles(): string[] {
	const files: string[] = [];
	// Mechanical, never a hand-kept list: a NEW clients/runtime-*.ts is in
	// scope the moment it lands, which is the whole point of a governance
	// registry (a hand-maintained mirror of a directory is the defect).
	for (const absolute of listSourceFiles(path.join(REPO_ROOT, "clients"), {
		skipTests: true,
	})) {
		const rel = relativePosix(REPO_ROOT, absolute);
		if (/^clients\/runtime-[^/]+\.ts$/.test(rel)) files.push(absolute);
	}
	for (const rel of ["index.ts", "mcp/server.ts", "clients/mcp/session.ts"]) {
		const absolute = path.join(REPO_ROOT, rel);
		if (fs.existsSync(absolute)) files.push(absolute);
	}
	return files.sort();
}

/** Every shipped source file the hand-rolled-race scan covers. */
function shippedSourceFiles(): string[] {
	const files = ["clients", "mcp", "tools"].flatMap((dir) => {
		const absolute = path.join(REPO_ROOT, dir);
		return fs.existsSync(absolute)
			? listSourceFiles(absolute, { skipTests: true })
			: [];
	});
	const indexTs = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files.sort();
}

/** An `await` token that is a KEYWORD, not a property name or an identifier tail. */
const AWAIT_TOKEN = /(?<![.\w$])await(?![\w$])/g;

/** A `Promise.race(` call head. */
const RACE_TOKEN = /\bPromise\s*\.\s*race\s*\(/g;

/** A timer arm: the shape that makes a race a hand-rolled bound. */
const TIMER_ARM = /\bsetTimeout\s*\(|\bAbortSignal\s*\.\s*timeout\s*\(/;

/**
 * How far ABOVE a `Promise.race(` to look for the timer that feeds it.
 *
 * The inline arm (`new Promise((r) => setTimeout(r, ms))` written straight
 * into the race) is the minority spelling. The dominant one hoists the arm
 * into a named local a few lines up — `clients/format-service.ts`'s
 * `timeoutPromise`, `clients/runtime-session.ts`'s
 * `readSequenceWithBudget` — and an inline-only detector called both of them
 * clean, which for a guard is the failure direction that hides. The window is
 * a line count rather than a scope walk for the same reason the rest of this
 * file is: a partial scope walk produces false negatives, a window produces
 * false positives, and a false positive is a table entry a reviewer reads.
 */
const RACE_TIMER_WINDOW = 25;

/** Call shapes that carry a real bound. See {@link SWEEP_HEURISTIC_LIMITS}. */
const BOUNDED_CALL = /^\s*bounded\s*\(/;
const DEADLINE_CALL =
	/^\s*(?:withDeadline|withTimeout|withBudget|withinRemaining)\s*\(/;
const RACE_CALL = /^\s*Promise\s*\.\s*race\s*\(/;

/**
 * Text of the call's own parentheses, starting at the `(` at or after
 * `from`. Paren matching over STRIPPED source, so a paren inside a comment or
 * string cannot unbalance it. Bounded by `maxChars` so one pathological
 * expression cannot turn this into a whole-file scan.
 */
function callArguments(
	stripped: string,
	from: number,
	maxChars = 4000,
): string {
	const open = stripped.indexOf("(", from);
	if (open < 0) return "";
	let depth = 0;
	const end = Math.min(stripped.length, open + maxChars);
	for (let i = open; i < end; i++) {
		const ch = stripped[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return stripped.slice(open, i + 1);
		}
	}
	return stripped.slice(open, end);
}

/** Is the expression starting at `at` (just past an `await`) bounded? */
function isBoundedAwait(stripped: string, at: number): boolean {
	const head = stripped.slice(at, at + 80);
	if (BOUNDED_CALL.test(head)) return true;
	if (DEADLINE_CALL.test(head) || RACE_CALL.test(head)) {
		return /\bsignal\b/.test(callArguments(stripped, at));
	}
	return false;
}

/** 1-based line number of `offset` in `source`. */
function lineOf(source: string, offset: number): number {
	return source.slice(0, offset).split("\n").length;
}

/**
 * Every unbounded-await LINE in one already-stripped source, 1-based.
 *
 * Exported so the detector itself can be pinned against synthetic fixtures
 * (the mutation tests below) rather than only against whatever happens to be
 * in the tree today — a detector that quietly stops detecting is defect shape
 * 10 wearing a green check.
 */
export function findUnboundedAwaitLines(stripped: string): number[] {
	const hits = new Set<number>();
	for (const match of stripped.matchAll(AWAIT_TOKEN)) {
		const at = match.index + match[0].length;
		if (isBoundedAwait(stripped, at)) continue;
		hits.add(lineOf(stripped, match.index));
	}
	return [...hits].sort((a, b) => a - b);
}

/**
 * Every hand-rolled timeout race LINE in one already-stripped source,
 * 1-based: a `Promise.race(` whose own arguments spell a timer.
 */
export function findHandRolledRaceLines(stripped: string): number[] {
	const hits = new Set<number>();
	const lines = stripped.split("\n");
	for (const match of stripped.matchAll(RACE_TOKEN)) {
		const line = lineOf(stripped, match.index);
		const args = callArguments(stripped, match.index + match[0].length - 1);
		const above = lines
			.slice(Math.max(0, line - 1 - RACE_TIMER_WINDOW), line - 1)
			.join("\n");
		if (TIMER_ARM.test(args) || TIMER_ARM.test(above)) hits.add(line);
	}
	return [...hits].sort((a, b) => a - b);
}

/**
 * Nearest non-blank RAW line in `direction` from `index`, or `""` at the edge
 * of the file.
 */
function neighbourLine(
	rawLines: readonly string[],
	index: number,
	direction: -1 | 1,
): string {
	for (
		let i = index + direction;
		i >= 0 && i < rawLines.length;
		i += direction
	) {
		const line = rawLines[i] ?? "";
		if (line.trim().length > 0) return line;
	}
	return "";
}

/**
 * A per-occurrence key: `stableOccurrenceKey`'s shape
 * (`path#enclosingSymbol:hash`, `path#hash` with no enclosing declaration),
 * with the hash taken over the flagged RAW line plus its two immediate
 * non-blank neighbours.
 *
 * Both differences from `stableOccurrenceKey` are forced by this family, and
 * both follow the kit's own instruction for a collision — "give each
 * occurrence a distinguishing key ... before exempting either":
 *
 * 1. **RAW, not stripped.** `lineContentHash` deletes all whitespace, so a
 *    STRIPPED `await import("./word-index.js")` and `await
 *    import("./call-graph.js")` are both `awaitimport("");` — one key for
 *    every dynamic import in the tree. Hashing the raw line keeps the
 *    specifier, which is the only thing that distinguishes them.
 * 2. **Plus its two immediate neighbours.** `await ensureReady(cwd);` appears
 *    four times in `mcp/server.ts` and `await loadBootstrapClients();` twice
 *    in `index.ts`, byte-identical, inside one enclosing declaration; without
 *    context they collide, and `auditRegistry`'s `requireUniqueFlagged`
 *    correctly refuses to let ONE exemption excuse four call sites. The
 *    neighbourhood is symmetric because one side is not enough: the two
 *    `} = await import("./word-index.js");` sites in `runtime-session.ts`
 *    share their preceding lines (both are the tail of a multi-line
 *    destructuring whose last names match) and are separated only by what
 *    follows.
 *
 * The trade is stated: editing the line directly above or below a flagged
 * site re-keys it, which `stableOccurrenceKey` avoids. That is the narrowest
 * context that separates this family, and it keeps #2475's actual property —
 * a line inserted ANYWHERE ELSE in the file does not re-key anything. Lift
 * this into `sweep-kit.ts` if a third sweep needs the same widening; one
 * caller is not yet a shared primitive.
 */
function awaitOccurrenceKey(
	rel: string,
	rawLines: readonly string[],
	strippedLines: readonly string[],
	index: number,
): string {
	const symbol = findEnclosingSymbol(strippedLines, index);
	// NUL separators: `lineContentHash` strips whitespace, so a newline would
	// vanish and `a\nb` would hash the same as `ab`.
	const hash = lineContentHash(
		[
			neighbourLine(rawLines, index, -1),
			rawLines[index] ?? "",
			neighbourLine(rawLines, index, 1),
		].join("\u0000"),
	);
	return symbol ? `${rel}#${symbol}:${hash}` : `${rel}#${hash}`;
}

interface FlaggedSite {
	key: string;
	detail: string;
}

/**
 * Run one line detector over one file group and key every hit.
 *
 * `prefix` namespaces the two families inside the single exemption table, so
 * an `await` and a race on the same line can never be confused for one
 * another (and `auditRegistry`'s stale check stays exact for both).
 */
function scanFiles(
	files: readonly string[],
	detect: (stripped: string) => number[],
	prefix: string,
	skipRel?: (rel: string) => boolean,
): { occurrences: FlaggedSite[]; scanned: number } {
	const occurrences: FlaggedSite[] = [];
	let scanned = 0;
	for (const absolute of files) {
		const rel = relativePosix(REPO_ROOT, absolute);
		if (skipRel?.(rel)) continue;
		scanned++;
		const raw = fs.readFileSync(absolute, "utf8");
		// Layout-preserving, so these line numbers and the hash inputs derived
		// from them line up with the raw source.
		const stripped = stripSource(raw);
		const strippedLines = stripped.split("\n");
		const rawLines = raw.split("\n");
		for (const line of detect(stripped)) {
			occurrences.push({
				key: `${prefix}${awaitOccurrenceKey(rel, rawLines, strippedLines, line - 1)}`,
				detail: `${rel}:${line}  ${(rawLines[line - 1] ?? "").trim().slice(0, 100)}`,
			});
		}
	}
	return { occurrences, scanned };
}

/** `auditRegistry` takes flat strings; the structure is folded in here. */
function exemptionReasons(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(EXEMPT_SITES)) {
		const budget = isHookBudgetKey(entry.site)
			? `${HOOK_WALL_BUDGET_MS[entry.site]}ms budget`
			: "no declared budget";
		out[key] =
			`[${entry.family}, ${entry.site}, ${budget}, owner ${entry.owner}] ${entry.reason}`;
	}
	return out;
}

const awaits = scanFiles(hookPathFiles(), findUnboundedAwaitLines, "");
const races = scanFiles(
	shippedSourceFiles(),
	findHandRolledRaceLines,
	"race:",
	(rel) => rel === DEFINITION_FILE,
);

describe("#2523 AC1 every hook-path await is bounded, and no new hand-rolled race", () => {
	it("scans both file groups and finds both families (a dead scan is not a clean one)", () => {
		// Two floors, two failure modes (#1755 review F4): a broken walk and a
		// broken detector must not share a message.
		expect(awaits.scanned).toBeGreaterThanOrEqual(8);
		expect(races.scanned).toBeGreaterThanOrEqual(200);
		expect(awaits.occurrences.length).toBeGreaterThanOrEqual(1);
		expect(races.occurrences.length).toBeGreaterThanOrEqual(1);
	});

	it("recognises a real bound and nothing else", () => {
		// Mutation guard on the DETECTOR (defect shape 10): each fixture is a
		// shape that appears in the scanned files today, or the shape slice 2
		// will replace it with.
		expect(findUnboundedAwaitLines("await loadBootstrapClients();")).toEqual([
			1,
		]);
		expect(
			findUnboundedAwaitLines(
				'await bounded(loadBootstrapClients(), { ms: 500, signal, hook: "tool_result", label: "bootstrap" });',
			),
		).toEqual([]);
		// A deadline with no signal is HALF a bound, which is the defect.
		expect(findUnboundedAwaitLines("await withBudget(sweep(), 500);")).toEqual([
			1,
		]);
		expect(
			findUnboundedAwaitLines(
				"await withDeadline(sweep(), { ms: 500, signal });",
			),
		).toEqual([]);
		expect(
			findUnboundedAwaitLines(
				"await Promise.race([sweep(), aborted(signal)]);",
			),
		).toEqual([]);
		// A line is bounded only if EVERY await on it is.
		expect(
			findUnboundedAwaitLines(
				'await bounded(a(), { ms: 1, signal, hook: "h", label: "l" }) + await raw();',
			),
		).toEqual([1]);
		// Not a keyword: a property named `await`, an identifier tail.
		expect(findUnboundedAwaitLines("queue.await(job);")).toEqual([]);
		expect(findUnboundedAwaitLines("const awaited = value;")).toEqual([]);
		// Comments and strings are blanked before the scan reaches them.
		expect(
			findUnboundedAwaitLines(stripSource("// await loadBootstrapClients();")),
		).toEqual([]);
		expect(
			findUnboundedAwaitLines(stripSource('const s = "await sweep();";')),
		).toEqual([]);
	});

	it("recognises a hand-rolled timeout race and nothing else", () => {
		expect(
			findHandRolledRaceLines(
				[
					"const winner = await Promise.race([",
					"\twork(),",
					"\tnew Promise((resolve) => setTimeout(resolve, 5000)),",
					"]);",
				].join("\n"),
			),
		).toEqual([1]);
		expect(
			findHandRolledRaceLines(
				"await Promise.race([work(), abortPromise(AbortSignal.timeout(500))]);",
			),
		).toEqual([1]);
		// The dominant spelling: the timer arm hoisted into a named local a few
		// lines above the race. An inline-only detector called this clean.
		expect(
			findHandRolledRaceLines(
				[
					"const timeoutPromise = new Promise((resolve) => {",
					"\ttimeoutHandle = setTimeout(() => resolve(TIMED_OUT), budgetMs);",
					"});",
					"const raced = await Promise.race([work(), timeoutPromise]);",
				].join("\n"),
			),
		).toEqual([4]);
		// A race with NO timer arm is not a hand-rolled bound — it is ordinary
		// first-past-the-post, and forbidding it would be a different rule.
		expect(
			findHandRolledRaceLines("await Promise.race([primary(), secondary()]);"),
		).toEqual([]);
		// A bare setTimeout with no race is a delay, not a bound.
		expect(
			findHandRolledRaceLines("await new Promise((r) => setTimeout(r, 10));"),
		).toEqual([]);
		expect(
			findHandRolledRaceLines(
				stripSource("// Promise.race([work(), setTimeout(done, 5)])"),
			),
		).toEqual([]);
	});

	it("MUTATION: a bare await planted on a hook path goes red, and bounded() makes it green", () => {
		// The end-to-end proof, through the REAL detector and the REAL audit —
		// not a hand-typed key. Planting the await must fail the guard even
		// though its file is full of already-exempted siblings.
		const rel = "clients/runtime-probe-hook.ts";
		const planted = [
			"export async function onProbeTurnEnd(deps: ProbeDeps): Promise<void> {",
			"\tawait sweepInlineBlockerFreshness(deps);",
			"}",
		].join("\n");
		const plantedRawLines = planted.split("\n");
		const plantedLines = stripSource(planted).split("\n");
		const plantedHits = findUnboundedAwaitLines(stripSource(planted));
		expect(plantedHits).toEqual([2]);
		const plantedAudit = auditRegistry({
			sweepName: "hook-await-bounds sweep",
			flagged: plantedHits.map((line) => ({
				key: awaitOccurrenceKey(rel, plantedRawLines, plantedLines, line - 1),
				detail: `${rel}:${line}`,
			})),
			registered: [],
			exemptions: exemptionReasons(),
			minFlagged: 1,
		});
		expect(plantedAudit.unaccounted).toHaveLength(1);
		expect(plantedAudit.problems.join("\n")).toContain("neither");

		// The same await wrapped in bounded() is not flagged at all, so there is
		// nothing left for an exemption to excuse.
		const wrapped = [
			"export async function onProbeTurnEnd(deps: ProbeDeps): Promise<void> {",
			"\tawait bounded(sweepInlineBlockerFreshness(deps), {",
			"\t\tms: HOOK_WALL_BUDGET_MS.turn_end,",
			"\t\tsignal: deps.signal,",
			'\t\thook: "turn_end",',
			'\t\tlabel: "sweepInlineBlockerFreshness",',
			"\t});",
			"}",
		].join("\n");
		expect(findUnboundedAwaitLines(stripSource(wrapped))).toEqual([]);
	});

	it("every exemption names a declared hook budget or a stated non-hook reason", () => {
		const entries = Object.entries(EXEMPT_SITES);
		for (const [key, entry] of entries) {
			expect(
				isHookBudgetKey(entry.site) ||
					entry.site === "off-hook" ||
					entry.site === "unbudgeted-hook",
				`${key}: site "${entry.site}" is not a declared hook budget key`,
			).toBe(true);
			expect(entry.owner, `${key}: no owning issue`).toMatch(/#\d+/);
			expect(
				key.startsWith("race:") === (entry.family === "hand-rolled-race"),
				`${key}: family "${entry.family}" does not match the key namespace`,
			).toBe(true);
		}
		// The binding to clients/hook-budgets.ts must not be vacuous: if every
		// entry were "off-hook" the table would assert nothing about any hook.
		const hookOwned = entries.filter(([, entry]) =>
			isHookBudgetKey(entry.site),
		);
		expect(hookOwned.length).toBeGreaterThanOrEqual(
			Math.max(1, Math.floor(entries.length / 4)),
		);
	});

	it("documents the heuristic's limits", () => {
		expect(SWEEP_HEURISTIC_LIMITS.length).toBeGreaterThanOrEqual(4);
		for (const limit of SWEEP_HEURISTIC_LIMITS) {
			expect(limit.length).toBeGreaterThan(40);
		}
	});

	it("every hook-path await and every hand-rolled race is bounded or exempted", () => {
		const audit = auditRegistry({
			sweepName: "hook-await-bounds sweep (#2523 AC1)",
			flagged: [...awaits.occurrences, ...races.occurrences],
			registered: [],
			exemptions: exemptionReasons(),
			scannedCount: awaits.scanned + races.scanned,
			// index.ts + mcp/server.ts + clients/mcp/session.ts + eight
			// clients/runtime-*.ts, plus ~450 shipped files for the race scan.
			minScanned: 208,
			minFlagged: 1,
			remediation:
				"An await: wrap it in bounded() from clients/deadline-utils.ts — it " +
				"takes the hook's budget from HOOK_WALL_BUDGET_MS " +
				"(clients/hook-budgets.ts) AND the hook's ctx.signal, and its type " +
				"refuses one without the other. A `race:` key: use bounded() (or " +
				"withDeadline for a signal-less leaf) instead of hand-rolling the " +
				"timer arm. Otherwise add an EXEMPT_SITES entry here keyed by the " +
				"printed occurrence key, with its family, the hook whose budget it " +
				"spends, a real reason, and the issue that owns closing it.",
		});
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
	});
});
