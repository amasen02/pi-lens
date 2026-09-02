/**
 * Zero-import dependency leaf (the same shape as `clients/process-singletons.ts`
 * — "a dependency leaf on purpose") holding the #2506 probe-home-redirect
 * resolution. `file-utils.ts`'s `getGlobalPiLensLogDir()` WRITES the slot;
 * `degradation-ledger.ts` READS it at summary time (`getDegradationSummary()`),
 * the same read-time-fold inversion the `log-sink-write-failure`
 * (`ndjson-logger.ts`) and `process-singleton-reset` (`process-singletons.ts`)
 * kinds already use.
 *
 * Why the ledger reads instead of the resolver writing to it directly:
 * `file-utils.ts` and `degradation-ledger.ts` are already mutually reachable
 * through the existing `file-utils.js` to `safe-spawn.js` to
 * `degradation-ledger.js` to `extension-log.js` and back to `file-utils.js`
 * cycle, pinned in `.dependency-cruiser-known-violations.json`. A DIRECT
 * import between them in EITHER direction — even a dynamic `import()`, which
 * is exempt from being individually FLAGGED but not from closing the cycle in
 * the first place, since other static edges already on that cycle then also
 * get marked circular — adds new, unpinned `no-client-cycles` violations
 * (caught live: an earlier dynamic-import attempt failed CI's "Dependency
 * boundaries" gate with exactly this shape).
 *
 * Why `file-utils.ts` does not import even THIS module, leaf though it is
 * (#2506 round 3): `log-cleanup.ts` calls `getGlobalPiLensLogDir()` at its own
 * module top level and reaches the resolver through that same cycle while
 * `file-utils.ts`'s module record is still mid-init. In that window an import
 * BINDING is not initialized either, so dereferencing one throws
 * `ReferenceError: Cannot access '...' before initialization` — caught live
 * TWICE on this issue, once as a module-scope `const` and once as the import
 * of this file. So `file-utils.ts` writes the shared `globalThis` slot
 * directly, naming the SAME key literal this module names below; a
 * `Symbol.for` property access is process-wide interned by string and has no
 * TDZ window at all. `tests/config/global-dir-probe-redirect.test.ts` pins the
 * two literals equal so the deliberate duplication cannot drift into two
 * silent slots.
 *
 * ONE state slot, not two (round 3, F6). It holds the memoized redirect
 * DECISION (`probeHome`, `undefined` when no redirect applies) together with
 * the degradation `event` that decision produced. Round 2 kept the event here
 * and a separate warn-once latch in `file-utils.ts`, so
 * `_resetProbeHomeRedirectStateForTests` cleared one symbol and left the
 * other — it could not actually reset anything, and had no callers. They are
 * one fact and are now stored, read and reset as one.
 */

/** The canonical `globalThis` key. `file-utils.ts` repeats this literal. */
export const PROBE_HOME_RESOLUTION_KEY = "pi-lens.probe-home-state.resolution";

export interface ProbeHomeRedirectEvent {
	probeHome: string;
	cwd: string;
}

export interface ProbeHomeResolution {
	/**
	 * The redirected probe home, or `undefined` when this process resolved to
	 * the real home. Storing the negative answer too is what makes this a memo:
	 * without it a non-redirected process would recompute the whole decision on
	 * every log write.
	 */
	probeHome: string | undefined;
	/** Set only when `probeHome` is set — the row the ledger folds at read time. */
	event: ProbeHomeRedirectEvent | undefined;
}

type GlobalWithProbeHomeState = typeof globalThis & {
	[key: symbol]: ProbeHomeResolution | undefined;
};

// `Symbol.for(...)` is recomputed inline in every function below — never
// hoisted to a module-scope `const` holding the SYMBOL — for the same reason
// the doc comment gives. (`PROBE_HOME_RESOLUTION_KEY` above is a plain string
// constant read only by tests, never on the resolver's mid-init path.)

/** The memoized resolution for this process, or `undefined` before first use. */
export function getProbeHomeResolution(): ProbeHomeResolution | undefined {
	return (globalThis as GlobalWithProbeHomeState)[
		Symbol.for("pi-lens.probe-home-state.resolution")
	];
}

/**
 * The degradation row for a redirect that actually happened, or `undefined`
 * when this process was not redirected (or has not resolved yet).
 * `degradation-ledger.ts`'s `getDegradationSummary()` is the only caller.
 */
export function getProbeHomeRedirectEvent():
	| ProbeHomeRedirectEvent
	| undefined {
	return getProbeHomeResolution()?.event;
}

/**
 * Clears the memoized decision AND the event it produced, so the next
 * `getGlobalPiLensLogDir()` call re-resolves from scratch. Exercised by
 * `tests/config/global-dir-probe-redirect.test.ts`, which drives the resolver
 * repeatedly under different in-process conditions; without it the first call
 * in a worker would pin the answer for every later case in the same file.
 */
export function _resetProbeHomeRedirectStateForTests(): void {
	(globalThis as GlobalWithProbeHomeState)[
		Symbol.for("pi-lens.probe-home-state.resolution")
	] = undefined;
}
