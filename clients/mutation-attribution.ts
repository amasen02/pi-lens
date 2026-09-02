/**
 * Learned mutation attribution for tools pi-lens cannot classify (#2430).
 *
 * ## Why this module exists
 *
 * `clients/mutating-tool.ts` recognizes a mutation by NAME (pi's built-ins) or
 * by input SHAPE (the adapter registry). The population of third-party edit
 * tools is open-ended, so neither tier can ever be complete: a tool called
 * `patch_file` taking `{target, body}` matches nothing and is dropped before
 * the first bookkeeping call.
 *
 * `clients/observed-mutation.ts` closes that by WATCHING — it snapshots a
 * bounded file set around an unclassified call and diffs it afterwards. This
 * module is the memory of what that watching learned, so the observation is
 * paid for at most twice per tool instead of on every call:
 *
 * - **First** observed mutation after tool X: `X -> mutating` for this SESSION,
 *   plus one `unclassified-mutating-tool` degradation record naming X, so the
 *   registry gap is visible rather than silent.
 * - **Second**: the attribution is PERSISTED under `getProjectDataDir(cwd)`, so
 *   a later session on the same project classifies X by name with no snapshot
 *   at all.
 *
 * The dual also matters: a tool observed to change NOTHING twice stops being
 * armed for the rest of the session. Without that, every `read`-shaped tool
 * carrying a `path` field would pay for a snapshot on every single call, which
 * is exactly the hot-path cost the net must not have. The settled sweep
 * (#2430 item 3) remains the last-resort net for anything this latch stops
 * watching.
 *
 * ## Lifetimes (catalog shape 17, shape 25)
 *
 * The session map and the loaded persisted set are SESSION state and are
 * cleared by `resetMutationAttribution` from the `runtime-session.ts` reset
 * block; `tests/support/session-state-registry.ts` registers them. The
 * container lives in a process singleton, because a second module evaluation
 * holding its own copy would re-emit the degradation record and re-write the
 * persisted file from a stale view (catalog shape 25).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomic } from "./atomic-write.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { getProjectDataDir } from "./file-utils.js";
import { getProcessSingleton } from "./process-singletons.js";

/** Persisted-file schema version. A file of any other version is ignored. */
export const MUTATION_ATTRIBUTION_FILE_VERSION = 1;

/** File under `getProjectDataDir(cwd)` holding the learned attributions. */
export const MUTATION_ATTRIBUTION_FILE = "observed-mutating-tools.json";

/**
 * Observations needed before an attribution is written to disk. One is enough
 * to classify for THIS session (the observation itself proved it); a second is
 * required before the claim outlives the session, so a single coincidental
 * co-occurrence — an unrelated tool call that happened to overlap a background
 * write — cannot durably mislabel a tool for every future session.
 */
export const PERSIST_AFTER_OBSERVATIONS = 2;

/**
 * Consecutive clean observations after which an UNATTRIBUTED tool stops being
 * armed for the session. Two, not one: a mutating tool whose FIRST call
 * happened to be a no-op (an edit that changed nothing) still gets a second
 * chance.
 */
export const CLEAN_OBSERVATION_ARM_LIMIT = 2;

/**
 * Consecutive clean observations after which a SESSION-learned attribution is
 * forgotten (#2449 review round 2, F4).
 *
 * The session map is a claim about a tool made from ONE disk observation, and
 * a claim made from evidence has to be revisable by evidence. Three armed
 * observations in a row where the tool's own target did not move is the
 * signal that the first observation was a coincidence — a background write, a
 * formatter, another agent — and the tool goes back to unattributed rather
 * than staying mislabelled for the rest of the session.
 *
 * Higher than {@link CLEAN_OBSERVATION_ARM_LIMIT} on purpose: forgetting is
 * the more consequential direction, so it takes strictly more evidence than
 * merely deciding to stop watching. It applies only BEFORE persistence — an
 * attribution that already earned {@link PERSIST_AFTER_OBSERVATIONS} is not
 * armed any more, so nothing can un-learn it by accident.
 */
export const DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS = 3;

/** Bound on distinct tool names remembered, in-memory and on disk. */
export const MUTATION_ATTRIBUTION_MAX_TOOLS = 64;

/** How the attribution for a tool was reached. */
export type LearnedMutationSource = "session" | "persisted";

interface ToolObservation {
	/** Times a mutation was actually observed after this tool ran. */
	mutating: number;
	/** Times an armed observation found nothing changed. */
	clean: number;
	/** Whether the persisted file already carries this tool. */
	persisted: boolean;
}

interface AttributionState {
	/** toolName -> counts. FIFO-bounded; see `MUTATION_ATTRIBUTION_MAX_TOOLS`. */
	session: Map<string, ToolObservation>;
	/** Tool names adopted from disk at `session_start`, or `undefined` until primed. */
	fromDisk: Set<string> | undefined;
	/** Project root the persisted set was primed for, for the write-back path. */
	primedCwd: string | undefined;
}

const ATTRIBUTION_FAMILY = "mutation-attribution";
const ATTRIBUTION_VERSION = 1;

function state(): AttributionState {
	return getProcessSingleton<AttributionState>(
		ATTRIBUTION_FAMILY,
		ATTRIBUTION_VERSION,
		() => ({ session: new Map(), fromDisk: undefined, primedCwd: undefined }),
	);
}

/**
 * FIFO insert with a hard cap. A local `Map` rather than
 * `clients/bounded-cache.ts` on purpose: that module is being reworked under
 * #2442 and this is a sixty-four-entry name map, not a cache with a hit/miss
 * story. If #2442 lands a FIFO map primitive, this is one of its adoption
 * sites.
 */
function put(
	map: Map<string, ToolObservation>,
	key: string,
	value: ToolObservation,
): void {
	if (!map.has(key) && map.size >= MUTATION_ATTRIBUTION_MAX_TOOLS) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

function observationFor(toolName: string): ToolObservation {
	const current = state().session.get(toolName);
	if (current) return current;
	const created: ToolObservation = { mutating: 0, clean: 0, persisted: false };
	put(state().session, toolName, created);
	return created;
}

function attributionFilePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), MUTATION_ATTRIBUTION_FILE);
}

interface PersistedAttributionEntry {
	name: string;
	observations: number;
	lastSeen: number;
}

interface PersistedAttributionFile {
	version: number;
	tools: PersistedAttributionEntry[];
}

function isPersistedEntry(entry: unknown): entry is PersistedAttributionEntry {
	const candidate = entry as Partial<PersistedAttributionEntry> | undefined;
	return (
		typeof candidate?.name === "string" &&
		candidate.name.length > 0 &&
		typeof candidate.observations === "number"
	);
}

function readPersisted(cwd: string): PersistedAttributionFile | undefined {
	try {
		const raw = fs.readFileSync(attributionFilePath(cwd), "utf-8");
		const parsed = JSON.parse(raw) as Partial<PersistedAttributionFile>;
		if (parsed?.version !== MUTATION_ATTRIBUTION_FILE_VERSION) return undefined;
		if (!Array.isArray(parsed.tools)) return undefined;
		return {
			version: MUTATION_ATTRIBUTION_FILE_VERSION,
			tools: parsed.tools
				.filter(isPersistedEntry)
				.slice(0, MUTATION_ATTRIBUTION_MAX_TOOLS)
				.map((entry) => ({
					name: entry.name,
					observations: entry.observations,
					lastSeen: typeof entry.lastSeen === "number" ? entry.lastSeen : 0,
				})),
		};
	} catch {
		// Missing or corrupt file: start with nothing learned. Never throw — a
		// broken attribution file must not break a session.
		return undefined;
	}
}

/**
 * Adopt this project's persisted attributions. Called once from the
 * `session_start` reset block, AFTER `resetMutationAttribution`, so a session
 * classifies a tool a previous session learned about with no snapshot.
 *
 * Synchronous by design: `classifyMutatingTool` is synchronous and on the
 * tool-event hot path, so the file is read once at a session boundary rather
 * than lazily from inside classification.
 */
export function primePersistedMutationAttribution(
	cwd: string | undefined,
): void {
	const current = state();
	current.primedCwd = cwd;
	current.fromDisk = new Set();
	if (!cwd) return;
	const file = readPersisted(cwd);
	if (!file) return;
	for (const entry of file.tools) current.fromDisk.add(entry.name);
}

/**
 * `"session"` or `"persisted"` when this tool has been attributed as mutating,
 * `undefined` otherwise. This is the lookup `classifyMutatingTool` consults for
 * its `provenance: "learned"` branch.
 */
export function lookupLearnedMutatingTool(
	toolName: string,
): LearnedMutationSource | undefined {
	const current = state();
	if ((current.session.get(toolName)?.mutating ?? 0) > 0) return "session";
	return current.fromDisk?.has(toolName) === true ? "persisted" : undefined;
}

/**
 * Whether a SESSION attribution exists but has not yet earned persistence.
 *
 * This is the window in which the tool IS classified by name (so #2430's
 * second acceptance criterion holds) and is STILL watched, because the second
 * observation that makes the attribution durable can only come from another
 * real disk diff. `runtime-tool-call.ts` consults this alongside
 * `classifyMutatingTool` when deciding whether to arm.
 */
export function isProvisionalLearnedAttribution(toolName: string): boolean {
	const current = state();
	if (current.fromDisk?.has(toolName) === true) return false;
	const observation = current.session.get(toolName);
	if (!observation || observation.persisted) return false;
	return (
		observation.mutating > 0 &&
		observation.mutating < PERSIST_AFTER_OBSERVATIONS
	);
}

/**
 * Whether a call to `toolName` should still pay for a snapshot.
 *
 * Three states, in order:
 *
 * 1. **Attributed durably** — persisted this session, or adopted from disk at
 *    `session_start`. Never armed: classification no longer needs the diff.
 * 2. **Attributed provisionally** — one observation, not yet persisted. STILL
 *    armed. The first cut returned `false` the moment
 *    `lookupLearnedMutatingTool` went non-`undefined`, which is after ONE
 *    observation, so `PERSIST_AFTER_OBSERVATIONS = 2` was unreachable on the
 *    production path and no attribution ever reached disk (#2449 review round
 *    2, F2). The only test that "proved" persistence called
 *    `noteObservedMutation` directly, so it proved the counter, not the path.
 * 3. **Unattributed** — armed until observed clean
 *    {@link CLEAN_OBSERVATION_ARM_LIMIT} times (it is not an edit tool, and
 *    re-proving that on every call is the hot-path cost this latch removes).
 */
export function shouldArmObservationForTool(toolName: string): boolean {
	const observation = state().session.get(toolName);
	if ((observation?.mutating ?? 0) > 0)
		return isProvisionalLearnedAttribution(toolName);
	if (state().fromDisk?.has(toolName) === true) return false;
	return (observation?.clean ?? 0) < CLEAN_OBSERVATION_ARM_LIMIT;
}

export interface ObservedMutationAttribution {
	/** Total mutating observations for this tool this session. */
	observations: number;
	/** `true` when this call wrote the attribution to disk. */
	persisted: boolean;
}

/**
 * Record that a mutation was observed after `toolName` ran.
 *
 * Emits ONE `unclassified-mutating-tool` degradation per tool (the ledger's
 * own once-key does the deduping), so a session report names every tool whose
 * edits pi-lens could only find by watching the disk.
 */
export function noteObservedMutation(
	toolName: string,
	cwd: string | undefined,
): ObservedMutationAttribution {
	const observation = observationFor(toolName);
	observation.mutating += 1;
	observation.clean = 0;
	recordDegradationOnce({
		kind: "unclassified-mutating-tool",
		subject: toolName,
		reason:
			"tool mutated a tracked file but matched no built-in name and no mutation shape adapter; classified by disk observation (#2430)",
	});
	let persisted = false;
	if (
		observation.mutating >= PERSIST_AFTER_OBSERVATIONS &&
		!observation.persisted
	) {
		persisted = persistAttribution(toolName, cwd, observation.mutating);
		observation.persisted = persisted;
	}
	return { observations: observation.mutating, persisted };
}

/**
 * Record that an armed observation found the tool's own target unchanged.
 *
 * Also the DE-ATTRIBUTION point (#2449 review round 2, F4). A session
 * attribution that then goes {@link DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS}
 * consecutive armed observations without its target moving is withdrawn: the
 * one observation behind it was a coincidence, and leaving it standing would
 * keep a read-shaped tool labelled as mutating for the rest of the session.
 *
 * The counter is deliberately NOT reset when the attribution is withdrawn.
 * Zeroing it would put the tool straight back into the armed-and-unattributed
 * state and re-arm it forever; leaving it at or above
 * {@link CLEAN_OBSERVATION_ARM_LIMIT} means "not attributed, and not worth
 * watching either", which is the truth the observations support.
 */
export function noteObservedClean(toolName: string): void {
	const observation = observationFor(toolName);
	observation.clean += 1;
	if (
		observation.mutating > 0 &&
		!observation.persisted &&
		observation.clean >= DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS
	) {
		observation.mutating = 0;
	}
}

function persistAttribution(
	toolName: string,
	cwd: string | undefined,
	observations: number,
): boolean {
	const root = cwd ?? state().primedCwd;
	if (!root) return false;
	try {
		const existing = readPersisted(root) ?? {
			version: MUTATION_ATTRIBUTION_FILE_VERSION,
			tools: [],
		};
		const tools = existing.tools.filter((entry) => entry.name !== toolName);
		tools.push({ name: toolName, observations, lastSeen: Date.now() });
		// Oldest-first drop keeps the cap honest without a second data structure.
		tools.sort((a, b) => a.lastSeen - b.lastSeen);
		const bounded = tools.slice(-MUTATION_ATTRIBUTION_MAX_TOOLS);
		const dir = getProjectDataDir(root);
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomic(
			path.join(dir, MUTATION_ATTRIBUTION_FILE),
			JSON.stringify({
				version: MUTATION_ATTRIBUTION_FILE_VERSION,
				tools: bounded,
			}),
		);
		state().fromDisk?.add(toolName);
		return true;
	} catch {
		// Persistence is an optimization for LATER sessions; this session already
		// has the attribution in memory, so a failed write must not break it.
		return false;
	}
}

/**
 * Session boundary (#2430). Clears the learned map and the adopted disk set so
 * a new session re-primes from disk instead of inheriting the previous
 * project's attributions — a `pi --session` switch can change project root.
 */
export function resetMutationAttribution(): void {
	const current = state();
	current.session.clear();
	current.fromDisk = undefined;
	current.primedCwd = undefined;
}

/** Test seam: the learned map, as plain data. */
export function _mutationAttributionSnapshotForTests(): {
	session: Array<[string, ToolObservation]>;
	fromDisk: string[] | undefined;
} {
	const current = state();
	return {
		session: [...current.session.entries()].map(([name, obs]) => [
			name,
			{ ...obs },
		]),
		fromDisk: current.fromDisk ? [...current.fromDisk] : undefined,
	};
}
