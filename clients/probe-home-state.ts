/**
 * Zero-import dependency leaf (the same shape as `clients/process-singletons.ts`
 * — "a dependency leaf on purpose") holding the #2506 probe-home-redirect
 * event. `file-utils.ts`'s `getGlobalPiLensDir()` WRITES here;
 * `degradation-ledger.ts` READS here at summary time
 * (`getDegradationSummary()`), the same read-time-fold inversion the
 * `log-sink-write-failure` (`ndjson-logger.ts`) and `process-singleton-reset`
 * (`process-singletons.ts`) kinds already use.
 *
 * Why the indirection: `file-utils.ts` and `degradation-ledger.ts` are
 * already mutually reachable through the existing
 * `file-utils.js -> safe-spawn.js -> degradation-ledger.js -> extension-log.js
 * -> file-utils.js` cycle, pinned in `.dependency-cruiser-known-violations.json`.
 * A DIRECT import between them in EITHER direction — even a dynamic
 * `import()`, which is exempt from being individually FLAGGED but not from
 * closing the cycle in the first place, since other static edges already on
 * that cycle then also get marked circular — adds new, unpinned
 * `no-client-cycles` violations (caught live: an earlier dynamic-import
 * attempt here failed CI's "Dependency boundaries" gate with exactly this
 * shape). Routing the signal through a true leaf module — no imports of its
 * own — adds no edge back toward either module, avoiding that problem.
 *
 * The event itself is `globalThis`-keyed, NOT a module-scope `let`: having
 * zero imports does not make a module immune to being called into before
 * ITS OWN body has run — `log-cleanup.ts`'s eager top-level
 * `getGlobalPiLensDir()` call can reach this module's exported function via
 * the SAME pre-existing cycle before this module's own evaluation has
 * started at all (a hoisted function BINDING is available at link time,
 * independent of when the target module's body actually runs — caught live:
 * a module-scope `let event` here threw the identical
 * `ReferenceError: Cannot access 'event' before initialization` this whole
 * file exists to avoid). `Symbol.for` is process-wide interned by string, a
 * plain property access with no TDZ, immune regardless of evaluation order.
 */

export interface ProbeHomeRedirectEvent {
	probeHome: string;
	cwd: string;
}

type GlobalWithProbeHomeEvent = typeof globalThis & {
	[key: symbol]: ProbeHomeRedirectEvent | undefined;
};

// `Symbol.for(...)` is recomputed inline in every function below — never
// hoisted to a module-scope `const` — for the same reason the doc comment
// above gives: a `const` binding is just as TDZ-vulnerable as a `let` one.

export function recordProbeHomeRedirectEvent(
	next: ProbeHomeRedirectEvent,
): void {
	(globalThis as GlobalWithProbeHomeEvent)[
		Symbol.for("pi-lens.probe-home-state.event")
	] = next;
}

export function getProbeHomeRedirectEvent():
	| ProbeHomeRedirectEvent
	| undefined {
	return (globalThis as GlobalWithProbeHomeEvent)[
		Symbol.for("pi-lens.probe-home-state.event")
	];
}

export function _resetProbeHomeRedirectStateForTests(): void {
	(globalThis as GlobalWithProbeHomeEvent)[
		Symbol.for("pi-lens.probe-home-state.event")
	] = undefined;
}
