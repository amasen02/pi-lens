/**
 * Generic mutation-recording bridge for pi-lens (#2423).
 *
 * ## Trust model — explicitly advisory
 *
 * Sibling of `clients/read-bridge.ts` and it inherits that module's trust
 * model verbatim: any code sharing this Node.js process already has full access
 * to pi-lens's internal state, so the bridge is not a security boundary. What
 * it provides is a stable API surface, one place for flag and scope checks, and
 * defensive validation that catches integration bugs early.
 *
 * ## What it is for
 *
 * `clients/mutating-tool.ts` classifies mutations pi-lens SEES as tool events.
 * A producer that writes a file some other way — a co-process extension with
 * its own registered tool, or pi-lens's own `ast_grep_replace` running
 * `--update-all` — is invisible to that path. It records the mutation here
 * instead, and the same downstream bookkeeping runs: read-guard staleness
 * stamp, turn-state modified ranges, an attributed change-log receipt, and a
 * DEFERRED autofix and format pass at `agent_settled`.
 *
 * Deferred, not immediate, is deliberate: a bulk rewrite usually touches many
 * files, and formatting each one as it lands fights the producer that is still
 * writing.
 *
 * Protocol (producer side)
 * ────────────────────────
 *
 *   const bridge = (globalThis as any)[Symbol.for("pi-lens:mutation-bridge")];
 *   bridge?.recordMutation({
 *     filePath,      // absolute path
 *     kind,          // "write" (whole file authored) or "edit" (part changed)
 *     touchedLines,  // optional [start, end], 1-based inclusive
 *     editRanges,    // optional [start, end][] for a scattered multi-range edit
 *     consumer,      // optional identifier, e.g. "my-extension"
 *   });
 *
 * Check `bridge.version` before calling. A bridge whose version you do not
 * recognize is unsupported. Calling before pi-lens is loaded, or when the guard
 * is disabled, is safe: the bridge is absent or the call is dropped.
 *
 * `recordMutation` returns `true` when pi-lens took the record and `false` when
 * it dropped it (malformed payload, out-of-scope path, or a bookkeeping error),
 * so a producer can count its own drops.
 *
 * Protocol (registration side, internal to pi-lens)
 * ──────────────────────────────────────────────────
 * `registerMutationBridge` is called once from the extension factory, next to
 * `registerReadBridge`, behind a module-level singleton guard so factory
 * re-activations do not mount a second bridge. Every dep is a GETTER resolved
 * at call time, so a replaced runtime or cache manager is picked up without
 * re-registration — the same live-getter discipline the read bridge uses.
 */
import {
	classifyBridgeMutation,
	type BridgeMutationEntry,
	type MutatingToolClassification,
} from "./mutating-tool.js";
import type { ProjectChangeSource } from "./project-changes.js";

/** Stable Symbol key — identical across module reloads in the same process. */
export const MUTATION_BRIDGE_KEY: unique symbol = Symbol.for(
	"pi-lens:mutation-bridge",
);

/** Payload a producer passes when recording a mutation. */
export type MutationBridgeEntry = BridgeMutationEntry;

/** The object mounted at `globalThis[MUTATION_BRIDGE_KEY]`. */
export interface MutationBridge {
	/**
	 * Bridge API version. Check this before calling `recordMutation` — if the
	 * version is not one you recognize, treat the bridge as unsupported.
	 */
	readonly version: 1;
	/** `true` when pi-lens recorded the mutation, `false` when it dropped it. */
	recordMutation(entry: MutationBridgeEntry): boolean;
}

/** The bookkeeping surfaces the bridge drives. Every one is optional-tolerant. */
export interface MutationBridgeDeps {
	getRuntime(): {
		turnIndex: number;
		telemetrySessionId?: string;
		readGuard?: { recordWritten?: (filePath: string) => void };
		recordProjectMutation?: (args: {
			filePath: string;
			source: ProjectChangeSource;
			cwd?: string;
			changedRange?: { start: number; end: number };
			onAppendError?: (err: unknown) => void;
		}) => unknown;
		deferMutation?: (
			filePath: string,
			cwd: string,
			toolName: string,
			turnStateCwd: string,
			kind: "autofix" | "format",
			ownerSessionId?: string,
			originCwd?: string,
		) => boolean;
	};
	getCacheManager(): {
		addModifiedRange?: (
			filePath: string,
			range: { start: number; end: number },
			importsChanged: boolean,
			cwd: string,
			sessionId?: string | null,
		) => unknown;
	};
	/** Workspace root used for turn-state and change-log bookkeeping. */
	getProjectRoot(): string;
	/** Formatter/language root for this file — the deferred pass's cwd. */
	getDispatchCwd(filePath: string): string;
	/** Line count used when a `write` records no explicit range. */
	countFileLines(filePath: string): number;
	/**
	 * Return `true` when the entry should be recorded. Called on EVERY
	 * `recordMutation` invocation so flag and project-root changes take effect
	 * immediately without re-registration.
	 */
	isRecordable(filePath: string): boolean;
	dbg?: (msg: string) => void;
}

function isValidRange(value: unknown): value is [number, number] {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [start, end] = value;
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 1 &&
		end >= start
	);
}

/**
 * Validate a raw entry from an untrusted caller. Deliberately lightweight, for
 * the same reason `read-bridge.ts` gives: this is an advisory protocol between
 * same-process extensions, so the goal is catching typos and bad numbers rather
 * than enforcing a boundary.
 */
export function isValidMutationEntry(
	entry: unknown,
): entry is MutationBridgeEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;

	if (typeof e["filePath"] !== "string" || e["filePath"] === "") return false;

	const kind = e["kind"];
	if (kind !== "write" && kind !== "edit") return false;

	if (e["touchedLines"] !== undefined && !isValidRange(e["touchedLines"]))
		return false;

	const editRanges = e["editRanges"];
	if (editRanges !== undefined) {
		if (!Array.isArray(editRanges) || editRanges.length === 0) return false;
		if (!editRanges.every(isValidRange)) return false;
	}

	if (e["consumer"] !== undefined && typeof e["consumer"] !== "string")
		return false;

	return true;
}

/**
 * The one range the change log records for this mutation. A multi-range edit
 * records its bounding box, matching how `runtime-tool-result.ts` collapses a
 * multi-hunk diff (`singleRange`) — the change log carries one range per entry.
 */
function resolveChangedRange(
	classification: MutatingToolClassification,
	deps: MutationBridgeDeps,
	filePath: string,
): { start: number; end: number } {
	if (classification.touchedLines) {
		const [start, end] = classification.touchedLines;
		return { start, end };
	}
	if (classification.editRanges && classification.editRanges.length > 0) {
		const starts = classification.editRanges.map(([start]) => start);
		const ends = classification.editRanges.map(([, end]) => end);
		return { start: Math.min(...starts), end: Math.max(...ends) };
	}
	// No range stated. A write replaced the whole file, and an edit whose ranges
	// the producer could not name is treated the same way: the safe
	// over-approximation is the entire file, never an empty set.
	return { start: 1, end: Math.max(1, deps.countFileLines(filePath)) };
}

/**
 * The mutation-recording body, exported so tests drive it against a real
 * `RuntimeCoordinator` and `CacheManager` without mounting the global
 * singleton.
 */
export function recordMutationThroughSeam(
	entry: unknown,
	deps: MutationBridgeDeps,
): boolean {
	if (!isValidMutationEntry(entry)) {
		deps.dbg?.("mutation_bridge: dropped malformed entry");
		return false;
	}
	if (!deps.isRecordable(entry.filePath)) {
		deps.dbg?.(`mutation_bridge: out of scope ${entry.filePath}`);
		return false;
	}

	const classification = classifyBridgeMutation(entry);
	const filePath = entry.filePath;
	const runtime = deps.getRuntime();
	const projectRoot = deps.getProjectRoot();
	const dispatchCwd = deps.getDispatchCwd(filePath);

	try {
		// 1. Staleness stamp: the file changed under pi-lens, so a later edit is
		//    judged by read coverage rather than by this write.
		runtime.readGuard?.recordWritten?.(filePath);

		// 2. Turn state: this is the insert that leaves `turn-state.json` `files`
		//    non-empty for a mutation no `tool_result` described.
		const changedRange = resolveChangedRange(classification, deps, filePath);
		deps
			.getCacheManager()
			.addModifiedRange?.(
				filePath,
				changedRange,
				false,
				projectRoot,
				runtime.telemetrySessionId,
			);

		// 3. Attributed change-log receipt. The source carries the producer's
		//    identity instead of collapsing onto `agent-edit`, so a report can
		//    tell an extension's rewrite apart from the model's own edit.
		runtime.recordProjectMutation?.({
			filePath,
			source: `agent-tool:${classification.toolName}`,
			cwd: projectRoot,
			changedRange,
			onAppendError: (err) =>
				deps.dbg?.(`mutation_bridge: change log append failed: ${err}`),
		});

		// 4. Deferred autofix and format at `agent_settled` — never immediate.
		for (const kind of ["autofix", "format"] as const) {
			runtime.deferMutation?.(
				filePath,
				dispatchCwd,
				classification.toolName,
				projectRoot,
				kind,
				runtime.telemetrySessionId,
				projectRoot,
			);
		}
	} catch (err) {
		// Bookkeeping must never break a producer's own write path.
		deps.dbg?.(`mutation_bridge: recording failed for ${filePath}: ${err}`);
		return false;
	}
	return true;
}

/**
 * Mount the bridge singleton. Call once from inside the extension factory,
 * protected by the caller's module-level flag. Subsequent calls are no-ops.
 */
export function registerMutationBridge(deps: MutationBridgeDeps): void {
	// `in` check so the frozen non-configurable property does not throw on a
	// redundant defineProperty attempt.
	if (MUTATION_BRIDGE_KEY in (globalThis as object)) return;

	const bridge: MutationBridge = Object.freeze({
		version: 1 as const,
		recordMutation(entry: MutationBridgeEntry): boolean {
			return recordMutationThroughSeam(entry, deps);
		},
	});

	// Non-writable and non-configurable so no later code silently replaces the
	// bridge — first-wins is the contract, same as the read bridge.
	Object.defineProperty(globalThis, MUTATION_BRIDGE_KEY, {
		value: bridge,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

/**
 * The mounted bridge, or `undefined` when pi-lens has not registered one.
 *
 * In-repo producers use this instead of reaching for `globalThis` themselves,
 * so there is one spelling of the key and one version check.
 */
export function getMutationBridge(): MutationBridge | undefined {
	const bridge = (globalThis as Record<symbol, unknown>)[MUTATION_BRIDGE_KEY];
	if (!bridge || typeof bridge !== "object") return undefined;
	const candidate = bridge as Partial<MutationBridge>;
	if (candidate.version !== 1) return undefined;
	return typeof candidate.recordMutation === "function"
		? (candidate as MutationBridge)
		: undefined;
}
