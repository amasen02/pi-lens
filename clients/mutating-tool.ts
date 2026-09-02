/**
 * The inbound mutation-classification seam (#2423).
 *
 * ## Why this module exists
 *
 * Before this seam, every producer in pi-lens decided "is this event a file
 * mutation?" by comparing `event.toolName` against the string literals
 * `"write"` and `"edit"`. Fifteen call sites across `runtime-tool-call.ts`,
 * `runtime-tool-result.ts`, `read-guard-tool-lines.ts`,
 * `runtime-coordinator.ts`, `read-guard.ts` and `agent-behavior-client.ts` each
 * made that decision on their own, so a host or extension that registered an
 * edit tool under ANY other name was dropped before the first bookkeeping
 * call: no read-guard preflight, no `turn-state.json` entry, no deferred
 * autofix, no format at `agent_settled`, no change-log receipt.
 *
 * The READ side already solved the same problem twice — `details.searchReads`
 * is consumed by SHAPE for any tool (#169), and `clients/read-bridge.ts` lets
 * an out-of-band producer record a read directly (#1265). This module plus
 * `clients/mutation-bridge.ts` is the mutation-side equivalent.
 *
 * ## The contract
 *
 * `classifyMutatingTool(event, ctx)` is THE way to ask whether an event mutates
 * a file. It answers with a {@link MutatingToolClassification} or `undefined`;
 * no consumer compares a tool name to `"write"` or `"edit"` itself.
 * `tests/clients/mutating-tool-classification.test.ts` greps `clients/` and
 * fails when such a literal comparison reappears outside this file.
 *
 * Three recognition tiers, applied in this order:
 *
 * 1. **The built-in table** — pi's own `write` and `edit`. Behavior is
 *    unchanged, and `write` short-circuits because its shape is unambiguous.
 * 2. **The shape-adapter registry** ({@link MUTATION_SHAPE_ADAPTERS}), promoted
 *    out of `resolveHashlineEditInput`. An adapter recognizes an INPUT SHAPE,
 *    not a name, so a third-party tool called `replace` or `insert` is
 *    classified on the strength of its arguments. Order is deterministic and
 *    the first non-`undefined` result wins.
 * 3. **The mutation bridge** (`clients/mutation-bridge.ts`) — an in-process
 *    producer that already knows it mutated a file calls `recordMutation` and
 *    gets a `provenance: "bridge"` classification from
 *    {@link classifyBridgeMutation}.
 *
 * ## Telemetry
 *
 * Every adapter stamps its own `source` discriminator into the existing
 * `touched_lines_detected` and `edit_preflight_blocked` read-guard events, so a
 * production log says WHICH shape resolved a range. Adapters log only when the
 * caller supplies `ctx.filePath`. A path-resolution call runs before the path
 * is known, passes no context, and stays silent, exactly as the pre-seam code
 * did.
 *
 * ## Deliberately not here
 *
 * A declarative `tools.mutating` catalog entry and the `FormatQueuedPayload.tool`
 * widening are public-API decisions and belong to the #2421 and #2415 program.
 * The tool-agnostic observational net, which would arm the opaque-mutation disk
 * diff around any unclassified call carrying a path-shaped field, is a
 * follow-up.
 */
import {
	boundedIndexesForCount,
	createReadGuardEditBatchSummary,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";

/**
 * What the mutation does to the file, independent of the tool's name.
 *
 * - `write` — the whole file is authored or replaced. No prior read is
 *   required, and the autofix pass may run immediately.
 * - `edit` — part of the file changes. The read-before-edit guard applies and
 *   the autofix pass is DEFERRED to `agent_settled`, because a partial edit is
 *   usually one of several and formatting between them fights the agent.
 *
 * An edit-shaped tool pi-lens does not otherwise know defaults to `edit`, the
 * safe timing.
 */
export type MutationKind = "write" | "edit";

/** How the classification was reached. */
export type MutationProvenance =
	/** `event.toolName` is in the built-in table. */
	| "builtin"
	/** A synthetic write pi-lens derived from a bash command (#168, #2000). */
	| "bash-derived"
	/** A shape adapter recognized the input of a tool pi-lens does not name. */
	| "declared"
	/** An in-process producer recorded it through `clients/mutation-bridge.ts`. */
	| "bridge";

/**
 * Line information an adapter resolved from a tool's input.
 *
 * Structurally a subset of `GuardLineResult` (`read-guard-tool-lines.ts`), so
 * an adapter result reaches the guard verbatim. It is declared here rather than
 * imported so this module has no dependency, not even a type one, on the
 * consumer that imports it.
 */
export interface MutationLineResult {
	touchedLines: [number, number] | undefined;
	/** Individual ranges for a multi-range edit; the guard checks each one. */
	editRanges?: [number, number][];
	preflightError?: string;
	editBatchSummary?: ReadGuardEditBatchSummary;
}

/** Optional context an adapter uses for telemetry and file probing. */
export interface MutatingToolContext {
	/** Resolved absolute path. When it is absent, adapters do not log. */
	filePath?: string;
	sessionId?: string;
	correlationId?: string;
}

/**
 * Recognizes one tool-input SHAPE. Returns `undefined` when the input is not
 * its shape, so the registry falls through to the next adapter.
 */
export type ShapeAdapter = (
	input: Record<string, unknown>,
	ctx: MutatingToolContext,
) => MutationLineResult | undefined;

/** One registry entry. */
export interface MutationShapeAdapter {
	/** Stable identity, used by the mutation-proof tests and in reports. */
	readonly name: string;
	/** What a match means for timing and for the read-before-edit guard. */
	readonly kind: MutationKind;
	readonly resolve: ShapeAdapter;
}

/** The answer `classifyMutatingTool` gives. */
export interface MutatingToolClassification {
	/** The tool name as the host reported it. */
	toolName: string;
	/** Path the tool targets, unresolved, as the tool spelled it. */
	path: string | undefined;
	kind: MutationKind;
	touchedLines?: [number, number];
	editRanges?: [number, number][];
	preflightError?: string;
	editBatchSummary?: ReadGuardEditBatchSummary;
	provenance: MutationProvenance;
	/** Adapter that resolved the lines. `undefined` for a built-in shape. */
	source?: string;
}

/**
 * pi's own mutating tools. This table is the ONLY place those two names are
 * compared against an event.
 */
const BUILTIN_MUTATING_TOOLS: ReadonlyMap<string, MutationKind> = new Map<
	string,
	MutationKind
>([
	["write", "write"],
	["edit", "edit"],
]);

/**
 * Header marker for an adapter's blocking verdict. Identical to the marker the
 * promoted `resolveHashlineEditInput` used, so the agent-facing text does not
 * change. It is a constant because this module's delivery surface is registered
 * in `clients/finding-delivery-gate.ts`.
 */
const BLOCKED_MARKER = "\u{1F534} BLOCKED —";

/**
 * `true` when the NAME alone identifies a pi built-in mutating tool.
 *
 * Name-only consumers use this: the agent-behavior heuristics see a tool name
 * and a path but never the event. It cannot see a third-party tool, because
 * that needs the input shape, so a consumer takes `classifyMutatingTool`'s
 * answer wherever the event is in hand.
 */
export function isMutatingToolName(toolName: string): boolean {
	return BUILTIN_MUTATING_TOOLS.has(toolName);
}

/** Built-in mutating tool names, for reports and tests. */
export function getBuiltinMutatingToolNames(): string[] {
	return [...BUILTIN_MUTATING_TOOLS.keys()];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Path field, in a fixed order. `path` is pi's spelling; `filePath` and
 * `file_path` are the two spellings third-party edit tools use in practice.
 */
function resolveMutationPath(
	input: Record<string, unknown>,
): string | undefined {
	for (const key of ["path", "filePath", "file_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Parse a hashline anchor (`"42"` or `"42: some code"`) to its 1-based line.
 * Moved here from `read-guard-tool-lines.ts` with the adapters that use it.
 */
export function parseHashlineAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") return undefined;
	const trimmed = anchor.trim();
	const separator = trimmed.indexOf(":");
	const lineText = separator === -1 ? trimmed : trimmed.slice(0, separator);
	if (!/^\d+$/.test(lineText)) return undefined;
	const line = Number(lineText);
	return Number.isInteger(line) && line > 0 ? line : undefined;
}

/** Bounding box plus per-range detail for a multi-range edit. */
export function combineRanges(ranges: [number, number][]): MutationLineResult {
	const starts = ranges.map(([start]) => start);
	const ends = ranges.map(([, end]) => end);
	return {
		touchedLines: [Math.min(...starts), Math.max(...ends)],
		editRanges: ranges.length > 1 ? ranges : undefined,
	};
}

/**
 * Shared blocking result for an adapter that recognized its shape but could not
 * resolve every operation to a range. Blocking is the safe outcome: an edit
 * whose target lines are unknown cannot be checked against what the agent read.
 *
 * Every blocking verdict ends with one concrete next-action line so the agent
 * recovers in a single turn (#328).
 */
function blockedByAdapter(args: {
	adapterSource: string;
	reasonKind: string;
	title: string;
	errors: string[];
	operationCount: number;
	retryHint: string;
	ctx: MutatingToolContext;
}): MutationLineResult {
	const indexes = boundedIndexesForCount(args.operationCount);
	const editBatchSummary = createReadGuardEditBatchSummary({
		requestedIndexes: indexes,
		requestedTotal: args.operationCount,
		rejectedReasons: indexes.map((index) => ({
			index,
			code: "preflight_blocked" as const,
		})),
		rejectedTotal: args.operationCount,
		durationMs: 0,
		terminalStatus: "blocked",
	});
	if (args.ctx.filePath) {
		logReadGuardEvent({
			event: "edit_preflight_blocked",
			correlationId: args.ctx.correlationId,
			sessionId: args.ctx.sessionId,
			filePath: args.ctx.filePath,
			metadata: {
				tool: "edit",
				source: args.adapterSource,
				reasonKind: args.reasonKind,
				operationCount: args.operationCount,
				errorCount: args.errors.length,
				errors: args.errors.slice(0, 10),
			},
		});
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: args.ctx.correlationId,
			filePath: args.ctx.filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
	}
	return {
		touchedLines: undefined,
		preflightError: `${BLOCKED_MARKER} ${args.title}\n\n${args.errors.join("\n")}\n\n${args.retryHint}`,
		editBatchSummary,
	};
}

function logTouchedLines(args: {
	adapterSource: string;
	result: MutationLineResult;
	operationCount: number;
	ctx: MutatingToolContext;
	extra?: Record<string, unknown>;
}): void {
	if (!args.ctx.filePath) return;
	logReadGuardEvent({
		event: "touched_lines_detected",
		correlationId: args.ctx.correlationId,
		sessionId: args.ctx.sessionId,
		filePath: args.ctx.filePath,
		metadata: {
			tool: "edit",
			source: args.adapterSource,
			touchedLines: args.result.touchedLines,
			editRanges: args.result.editRanges,
			operationCount: args.operationCount,
			...args.extra,
		},
	});
}

// ---------------------------------------------------------------------------
// Adapter: hashline-readmap (the shape `resolveHashlineEditInput` recognized)
// ---------------------------------------------------------------------------

function getHashlineOperations(input: Record<string, unknown>): unknown[] {
	if (Array.isArray(input.operations)) return input.operations;
	if (Array.isArray(input.ops)) return input.ops;
	if (input.set_line || input.replace_lines || input.replace_symbol)
		return [input];
	return [];
}

const hashlineReadmapAdapter: ShapeAdapter = (input, ctx) => {
	const operations = getHashlineOperations(input);
	if (operations.length === 0) return undefined;
	const ranges: [number, number][] = [];
	const errors: string[] = [];

	for (let index = 0; index < operations.length; index += 1) {
		const op = asRecord(operations[index]);
		if (op.set_line) {
			const payload = asRecord(op.set_line);
			const line = parseHashlineAnchor(payload.anchor);
			if (!line) {
				errors.push(`operation[${index}].set_line.anchor is malformed`);
				continue;
			}
			ranges.push([line, line]);
			continue;
		}
		if (op.replace_lines) {
			const payload = asRecord(op.replace_lines);
			const start = parseHashlineAnchor(payload.start_anchor);
			const end = parseHashlineAnchor(payload.end_anchor);
			if (!start || !end) {
				errors.push(`operation[${index}].replace_lines anchors are malformed`);
				continue;
			}
			if (start > end) {
				errors.push(`operation[${index}].replace_lines range is inverted`);
				continue;
			}
			ranges.push([start, end]);
			continue;
		}
		if (op.replace_symbol) {
			errors.push(
				`operation[${index}].replace_symbol cannot be resolved safely yet; use line anchors or a native ranged edit`,
			);
			continue;
		}
		errors.push(`operation[${index}] is not a recognized hashline edit`);
	}

	if (errors.length > 0) {
		const target = ctx.filePath ? `\`${ctx.filePath}\`` : "the file";
		return blockedByAdapter({
			adapterSource: "hashline_edit",
			reasonKind: "unsupported_hashline_edit_target",
			title: "Unsupported hashline edit target",
			errors,
			operationCount: operations.length,
			retryHint: `Re-read ${target} to get current #line anchors, then retry using set_line / replace_lines with those anchors — or use a native ranged edit.`,
			ctx,
		});
	}
	if (ranges.length === 0) return undefined;
	const result = combineRanges(ranges);
	logTouchedLines({
		adapterSource:
			ranges.length === 1 && ranges[0][0] === ranges[0][1]
				? "hashline_set_line"
				: "hashline_replace_lines",
		result,
		operationCount: operations.length,
		ctx,
	});
	return result;
};

// ---------------------------------------------------------------------------
// Adapter: hashline-edit-pro
// ---------------------------------------------------------------------------

function isHashlineProReplace(input: Record<string, unknown>): boolean {
	return input.remove_from !== undefined || input.remove_to !== undefined;
}

function isHashlineProInsert(input: Record<string, unknown>): boolean {
	return input.anchor !== undefined && input.direction !== undefined;
}

/**
 * `hashline-edit-pro` ships two operations, both addressed by hashline anchor:
 *
 * - `replace`: `{path, remove_from, remove_to, replacement_lines}` — an
 *   inclusive line range, resolved directly.
 * - `insert`: `{path, anchor, direction, lines}` — a zero-width insertion
 *   before or after one anchor line. The anchor line itself is the range the
 *   guard checks, because that is the line the agent must have read to name it.
 *   When the anchor has drifted, the guard's own content-verified relocation
 *   (`ReadGuard.findRelocation`, the #505 machinery) reports where the read
 *   content moved to and offers the auto-apply. The adapter deliberately does
 *   not re-implement that search.
 */
const hashlineEditProAdapter: ShapeAdapter = (input, ctx) => {
	if (isHashlineProReplace(input)) {
		const start = parseHashlineAnchor(input.remove_from);
		const end = parseHashlineAnchor(input.remove_to);
		const errors: string[] = [];
		if (!start) errors.push("replace.remove_from anchor is malformed");
		if (!end) errors.push("replace.remove_to anchor is malformed");
		if (start && end && start > end)
			errors.push("replace range is inverted (remove_from is after remove_to)");
		if (errors.length > 0 || !start || !end) {
			const target = ctx.filePath ? `\`${ctx.filePath}\`` : "the file";
			return blockedByAdapter({
				adapterSource: "hashline_edit_pro",
				reasonKind: "unsupported_hashline_pro_replace",
				title: "Unresolvable hashline replace range",
				errors,
				operationCount: 1,
				retryHint: `Re-read ${target} to get current #line anchors, then retry replace with remove_from and remove_to set to those anchors.`,
				ctx,
			});
		}
		const result = combineRanges([[start, end]]);
		logTouchedLines({
			adapterSource: "hashline_pro_replace",
			result,
			operationCount: 1,
			ctx,
		});
		return result;
	}

	if (isHashlineProInsert(input)) {
		const line = parseHashlineAnchor(input.anchor);
		const direction =
			typeof input.direction === "string" ? input.direction : undefined;
		const errors: string[] = [];
		if (!line) errors.push("insert.anchor is malformed");
		if (direction !== "before" && direction !== "after")
			errors.push(
				`insert.direction must be "before" or "after" (got ${JSON.stringify(input.direction)})`,
			);
		if (errors.length > 0 || !line) {
			const target = ctx.filePath ? `\`${ctx.filePath}\`` : "the file";
			return blockedByAdapter({
				adapterSource: "hashline_edit_pro",
				reasonKind: "unsupported_hashline_pro_insert",
				title: "Unresolvable hashline insert anchor",
				errors,
				operationCount: 1,
				retryHint: `Re-read ${target} to get a current #line anchor, then retry insert with that anchor and direction "before" or "after".`,
				ctx,
			});
		}
		const result = combineRanges([[line, line]]);
		logTouchedLines({
			adapterSource: "hashline_pro_insert",
			result,
			operationCount: 1,
			ctx,
			extra: { direction },
		});
		return result;
	}

	return undefined;
};

/**
 * The registry. ORDER IS THE CONTRACT: adapters run top to bottom and the first
 * non-`undefined` result wins, so a narrower shape must precede a broader one.
 * `hashline-readmap` is first because it keys off explicit `operations`,
 * `set_line` and `replace_lines` fields that no other shape carries.
 *
 * Each entry is covered by its own case in
 * `tests/clients/mutating-tool-classification.test.ts`; deleting an entry turns
 * that case red.
 */
export const MUTATION_SHAPE_ADAPTERS: readonly MutationShapeAdapter[] = [
	{ name: "hashline-readmap", kind: "edit", resolve: hashlineReadmapAdapter },
	{ name: "hashline-edit-pro", kind: "edit", resolve: hashlineEditProAdapter },
];

function readToolName(event: unknown): string | undefined {
	const name = (event as { toolName?: unknown } | undefined)?.toolName;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * pi-lens's own marker on a `tool_result` it SYNTHESIZED from a bash command
 * (`runtime-tool-result.ts`'s recognized-write and opaque-recovery dispatch).
 * The event carries `toolName: "write"` so the pipeline treats it as one, but
 * the provenance is not the host's write tool, and a consumer that attributes
 * changes to the model must be able to tell them apart.
 */
export const PI_LENS_SYNTHETIC_MUTATION_FIELD = "piLensSyntheticMutation";

/**
 * Classify an inbound `tool_call` or `tool_result` event.
 *
 * Returns `undefined` for every event that is not a file mutation pi-lens
 * recognizes. That is the "not our business" answer every consumer keys off.
 *
 * Cost: one map lookup for `write`, plus at most one shallow shape probe per
 * registered adapter for everything else. The PR body carries the measurement.
 */
export function classifyMutatingTool(
	event: unknown,
	ctx: MutatingToolContext = {},
): MutatingToolClassification | undefined {
	const toolName = readToolName(event);
	if (toolName === undefined) return undefined;
	const input = asRecord((event as { input?: unknown }).input);
	const builtinKind = BUILTIN_MUTATING_TOOLS.get(toolName);
	const syntheticSource = (event as Record<string, unknown>)[
		PI_LENS_SYNTHETIC_MUTATION_FIELD
	];
	const builtinProvenance: MutationProvenance =
		syntheticSource === "bash" ? "bash-derived" : "builtin";

	// A full-file write has no shape ambiguity, so it never pays for the
	// adapter probes.
	if (builtinKind === "write") {
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: "write",
			provenance: builtinProvenance,
		};
	}

	for (const adapter of MUTATION_SHAPE_ADAPTERS) {
		const resolved = adapter.resolve(input, ctx);
		if (resolved === undefined) continue;
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: adapter.kind,
			touchedLines: resolved.touchedLines,
			editRanges: resolved.editRanges,
			preflightError: resolved.preflightError,
			editBatchSummary: resolved.editBatchSummary,
			// A built-in name that an adapter resolved is still built-in; only a
			// name pi-lens does not know is a declared third-party shape.
			provenance: builtinKind !== undefined ? builtinProvenance : "declared",
			source: adapter.name,
		};
	}

	if (builtinKind !== undefined) {
		return {
			toolName,
			path: resolveMutationPath(input),
			kind: builtinKind,
			provenance: builtinProvenance,
		};
	}

	return undefined;
}

/** Payload the mutation bridge validates and hands to the seam. */
export interface BridgeMutationEntry {
	filePath: string;
	kind: MutationKind;
	touchedLines?: [number, number];
	editRanges?: [number, number][];
	/** Producer identity, surfaced as the tool name on the classification. */
	consumer?: string;
}

/**
 * Build the classification for a mutation an in-process producer recorded
 * directly. The bridge does not guess a shape, because the producer states the
 * kind, so this is a construction rather than a recognition.
 */
export function classifyBridgeMutation(
	entry: BridgeMutationEntry,
): MutatingToolClassification {
	return {
		toolName: entry.consumer ?? "unknown",
		path: entry.filePath,
		kind: entry.kind,
		touchedLines: entry.touchedLines,
		editRanges: entry.editRanges,
		provenance: "bridge",
		source: "mutation-bridge",
	};
}
