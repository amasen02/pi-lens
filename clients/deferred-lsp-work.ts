/**
 * The one owner of "work that keeps talking to the LSP service after the hook
 * that started it has returned" (#2504 review round 2, F3).
 *
 * #2504 moved the cold-cache actionable-warnings fresh-pull loop off the
 * awaited `turn_end` hook. That loop then had effectively ONE bound: it
 * captured the COMPLETED turn's `ctx.signal` — which `index.ts` clears from
 * the ambient slot in its `finally`, so it can never fire — plus a 60 s wall
 * deadline checked only BETWEEN files. A wedged `getDiagnostics` was therefore
 * unbounded, the loop kept opening files (and could re-spawn servers) after
 * `turn_end` returned and after the LSP idle reset, a `session_shutdown`
 * landing mid-loop hit the #234 spawn-at-teardown shape, and the handle was a
 * module-level `let` with no reset that a second deferral simply overwrote.
 *
 * This module supplies the missing halves: ONE registered handle (arming
 * aborts whatever previously held the slot) and ONE abort signal that
 * `resetLSPService` fires — the single choke point through which
 * `session_shutdown`, `session_start` and the idle reset all retire the
 * service, so no caller has to remember to wire each lifecycle event
 * separately. Aborting only ever settles a promise; it never spawns, which is
 * what AGENTS.md's #234 teardown rule requires of anything reachable from
 * `session_shutdown`.
 *
 * Deliberately a zero-dependency leaf, for the same reason
 * `map-with-concurrency.ts` is one: `clients/lsp/index.ts` must not gain an
 * import edge to `actionable-warnings.ts` (and through it `lsp/edits.ts`,
 * `lsp-mutation.ts`, the durable store …) for a 20-line handle registry.
 */

let deferredController: AbortController | undefined;
let deferredWork: Promise<void> | undefined;

/**
 * Abort the in-flight deferred LSP work, if any, and drop the slot.
 *
 * Safe at teardown: it settles a promise and spawns nothing. Idempotent — a
 * second call with no armed work is a no-op.
 */
export function abortDeferredLspWork(reason: string): void {
	const controller = deferredController;
	deferredController = undefined;
	deferredWork = undefined;
	controller?.abort(new Error(reason));
}

/**
 * Claim the deferred-work slot and return the signal the new work must honor.
 *
 * Arming ABORTS whatever previously held the slot: two deferrals may not run
 * concurrently against the same LSP service, and the pre-fix code overwrote
 * the handle so the first loop kept running untracked and unstoppable.
 */
export function armDeferredLspWork(): AbortSignal {
	abortDeferredLspWork("superseded by a newer deferred LSP pull");
	const controller = new AbortController();
	deferredController = controller;
	return controller.signal;
}

/**
 * Register the armed work's promise so callers (and tests) have something to
 * await. Ignored when the slot has already been re-armed or aborted since — a
 * late registration must not resurrect a retired handle.
 */
export function registerDeferredLspWork(
	signal: AbortSignal,
	work: Promise<void>,
): void {
	if (deferredController?.signal !== signal) return;
	deferredWork = work;
}

/** The in-flight deferred work, or an already-resolved promise when idle. */
export function awaitDeferredLspWork(): Promise<void> {
	return deferredWork ?? Promise.resolve();
}

/** True while a deferral holds the slot and has not been aborted. */
export function isDeferredLspWorkArmed(): boolean {
	return deferredController?.signal.aborted === false;
}

/** Test-only: drop the slot without aborting, for suite isolation. */
export function _resetDeferredLspWorkForTests(): void {
	deferredController = undefined;
	deferredWork = undefined;
}
