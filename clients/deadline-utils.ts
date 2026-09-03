/**
 * One implementation of the "race a promise against a timer" pattern that had
 * drifted into three near-identical copies (#366): `withTimeout` (clients/lsp),
 * `withBudget` (read-expansion), and `withinRemaining` (module-report-lsp).
 *
 * The differences between them were real — timeout can *reject* or *resolve
 * undefined*, and the raced promise's own rejection can *propagate* or be
 * *swallowed* — so they are kept as named adapters over one core. Consolidating
 * fixes two latent bugs the copies had: `withBudget` did not suppress the loser
 * promise's late rejection (an unhandled rejection if the timer won first), and
 * `withinRemaining` never cleared its timer.
 */

import { recordDegradationOnce } from "./degradation-ledger.js";

/**
 * Combine multiple abort signals into one that aborts when ANY of them does.
 * Returns the single signal unchanged when only one is live, and `undefined`
 * when none are — so callers can pass it straight through. Used so a tool honors
 * both its tool-call `signal` positional and the turn-wired `ctx.signal` (Escape),
 * and to fold in a wall-clock ceiling via `AbortSignal.timeout`.
 */
export function combineAbortSignals(
	...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length <= 1) return live[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
	const controller = new AbortController();
	for (const s of live) {
		if (s.aborted) {
			controller.abort((s as AbortSignal & { reason?: unknown }).reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), {
			once: true,
		});
	}
	return controller.signal;
}

export interface DeadlineOptions {
	/** Duration budget in ms. Provide this OR `deadlineAt`. */
	ms?: number;
	/** Absolute deadline (`Date.now()`-based). Provide this OR `ms`. */
	deadlineAt?: number;
	/**
	 * What happens when the timer wins first:
	 *  - `"reject"` (default): reject with `Error("Timeout after <ms>ms")`.
	 *  - `"undefined"`: resolve to `undefined`.
	 */
	onTimeout?: "reject" | "undefined";
	/**
	 * What happens if `promise` itself rejects:
	 *  - `"propagate"` (default): rethrow the rejection.
	 *  - `"undefined"`: swallow it and resolve to `undefined`.
	 */
	onReject?: "propagate" | "undefined";
}

// reject-on-timeout + propagate-rejection can never yield `undefined`, so it
// keeps the precise `Promise<T>` return; any undefined-producing mode is `T | undefined`.
export function withDeadline<T>(
	promise: Promise<T>,
	options: {
		ms?: number;
		deadlineAt?: number;
		onTimeout?: "reject";
		onReject?: "propagate";
	},
): Promise<T>;
export function withDeadline<T>(
	promise: Promise<T>,
	options: DeadlineOptions,
): Promise<T | undefined>;
export function withDeadline<T>(
	promise: Promise<T>,
	options: DeadlineOptions,
): Promise<T | undefined> {
	const onTimeout = options.onTimeout ?? "reject";
	const onReject = options.onReject ?? "propagate";
	const ms =
		options.ms ??
		(options.deadlineAt !== undefined ? options.deadlineAt - Date.now() : 0);

	// Past deadline / non-positive budget: settle immediately, no timer. This
	// branch returns before the race below ever runs, so — same reason as the
	// loser-leg catch a few lines down — `promise` needs its own no-op catch
	// here too: without it, a `promise` that eventually rejects (the caller
	// already invoked it; this function only decides how long to wait on it)
	// surfaces as an unhandled rejection instead of being silently superseded
	// by the immediate timeout/undefined settlement.
	if (ms <= 0) {
		promise.catch(() => {});
		return onTimeout === "undefined"
			? Promise.resolve(undefined)
			: Promise.reject(new Error(`Timeout after ${Math.max(0, ms)}ms`));
	}

	// Base promise with rejection handled per `onReject`. In propagate mode we
	// still attach a no-op catch so that if the timer wins the race, the loser
	// promise's later rejection does not surface as an unhandled rejection.
	const base: Promise<T | undefined> =
		onReject === "undefined" ? promise.catch(() => undefined) : promise;
	if (onReject === "propagate") promise.catch(() => {});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<T | undefined>((resolve, reject) => {
		timer = setTimeout(() => {
			if (onTimeout === "undefined") resolve(undefined);
			else reject(new Error(`Timeout after ${ms}ms`));
		}, ms);
	});

	return Promise.race([base, timeoutPromise]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Resolve `promise`, or reject with `Error("Timeout after <ms>ms")` once
 * `timeoutMs` elapses. The raced promise's own rejection propagates.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return withDeadline(promise, { ms: timeoutMs });
}

/**
 * Resolve `promise`, or `undefined` once `budgetMs` elapses (a non-positive
 * budget resolves `undefined` immediately). The raced promise's own rejection
 * propagates.
 */
export function withBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
): Promise<T | undefined> {
	return withDeadline(promise, { ms: budgetMs, onTimeout: "undefined" });
}

/**
 * Resolve `promise`, or `undefined` once the shared `deadlineAt` passes (a past
 * deadline resolves `undefined` immediately). The raced promise's own rejection
 * is swallowed to `undefined`.
 */
export function withinRemaining<T>(
	promise: Promise<T>,
	deadlineAt: number,
): Promise<T | undefined> {
	return withDeadline(promise, {
		deadlineAt,
		onTimeout: "undefined",
		onReject: "undefined",
	});
}

/**
 * The abort half of a bound, as a value the race can settle on. A symbol, not
 * `undefined`, so `bounded` can tell "the signal fired" from "the awaited work
 * genuinely resolved `undefined`" — the distinction AGENTS.md defect shape 10
 * (silencing counted as fixing) exists to protect.
 */
const BOUND_ABORTED: unique symbol = Symbol("pi-lens/bounded/aborted");

/** Everything {@link bounded} needs. Both bounds are REQUIRED — see below. */
export interface BoundedOptions {
	/**
	 * Wall-clock budget in ms. NOT optional: a deadline-only call is the exact
	 * defect this helper exists to make unrepresentable, so the type refuses it.
	 * Read the number from `HOOK_WALL_BUDGET_MS` (`clients/hook-budgets.ts`)
	 * rather than inventing a per-call literal.
	 */
	ms: number;
	/**
	 * The HOOK's abort signal — `ctx.signal`, threaded down through the deps
	 * object, never `getAmbientAbortSignal()`. NOT optional, for the same
	 * reason `ms` is not: a wall-clock-only bound leaves Escape unable to
	 * release the hook, which is precisely what #2523's probe measured
	 * (`still-blocked after 30011ms` with the ambient abort fired at t=2s).
	 */
	signal: AbortSignal;
	/** Hook this await runs under, e.g. `"turn_end"`. Half of the ledger key. */
	hook: string;
	/** What is being awaited, e.g. `"sweepInlineBlockerFreshness"`. */
	label: string;
}

/**
 * Await `promise` under BOTH bounds a hook needs: a wall-clock budget AND the
 * hook's own abort signal (#2523 AC2).
 *
 * ## Why the type refuses one bound
 *
 * Every bound in this codebase lived at a LEAF — a spawn timeout, an LSP wait
 * — so a dependency that wedged before reaching the leaf was unreachable by
 * all of them, and `wrapSessionEventHandler` adds neither. The two halves fail
 * differently and neither substitutes for the other: a deadline alone means
 * Escape cannot release the hook (measured: still blocked 30s after the abort
 * fired), and a signal alone means a dependency that wedges without anyone
 * pressing Escape never returns at all (measured: 400s, the harness ceiling).
 * `ms` and `signal` are therefore both non-optional properties, so
 * `bounded(p, { ms: 500, hook, label })` is a COMPILE error, not a review
 * catch. `tests/clients/bounded-hook-await.test.ts` pins that with
 * `@ts-expect-error`: weaken either property and those directives become
 * unused, which `tsc` reports as TS2578.
 *
 * ## Semantics
 *
 * - Resolves to the promise's value when it settles inside both bounds.
 * - Resolves to `undefined` when the budget elapses OR the signal aborts,
 *   whichever comes first — and firing the signal settles IMMEDIATELY, it
 *   never waits the remaining deadline out.
 * - Rejections propagate: this helper decides how LONG to wait, never what an
 *   error means. Once a bound has fired, a later rejection from the
 *   superseded promise is suppressed (`withDeadline` attaches the no-op catch)
 *   so it cannot surface as an unhandled rejection.
 * - Exceeding a bound records ONE rising-edge `hook-await-exceeded`
 *   degradation per (hook, label) via `recordDegradationOnce`, naming the
 *   hook, the await, the budget, the actual elapsed ms, and which bound fired.
 *   Bounded by construction: a hook that blows its budget on every turn of a
 *   long session writes one ledger row, not one per turn. Promote it to
 *   `incrementDegradationCount` if slice 2 finds the exact tally is needed.
 *
 * `undefined` therefore means "no answer inside the bound" and must never be
 * read as an empty/clean ANSWER (defect shape 10, and the #240 lesson that a
 * failed diagnostic pull is not a clean file). The caller decides what the
 * absence means; the ledger row is what makes it visible either way.
 *
 * The promise is not cancelled — nothing here can cancel work already
 * started. It is abandoned, with the abandonment recorded. Work that must not
 * outlive its hook needs the signal threaded INTO it as well (#2523 slice 2's
 * `TurnEndDeps`/`AgentEndDeps`/`SessionStartDeps` change); wrapping the await
 * bounds the HOOK, not the work.
 */
export async function bounded<T>(
	promise: Promise<T>,
	options: BoundedOptions,
): Promise<T | undefined> {
	const { signal, hook, label } = options;
	// A non-finite budget settles immediately rather than throwing. The type
	// forbids it, but a JS caller (or a `@ts-expect-error` probe) can still
	// hand one over, and `AbortSignal.timeout(NaN)` throws ERR_OUT_OF_RANGE —
	// a helper whose whole job is keeping a hook from blowing up must not
	// itself blow up inside one. Same `Number.isFinite`-before-`Math.max` gate
	// the runtime-config readers use.
	const ms = Number.isFinite(options.ms) ? Math.max(0, options.ms) : 0;
	const startedAt = Date.now();
	// One combined signal rather than two races: `combineAbortSignals` already
	// owns the AbortSignal.any/fallback split, and folding the wall clock in as
	// a signal keeps a single settle path for both bounds. Node's
	// `AbortSignal.timeout` timer is unref'd, so it cannot hold the event loop
	// open past the hook it bounds.
	const timeoutSignal = AbortSignal.timeout(ms);
	// Two live signals are always passed, so the combined result is never
	// `undefined`; the assertion states that rather than inventing a fallback.
	const combined = combineAbortSignals(signal, timeoutSignal) as AbortSignal;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<typeof BOUND_ABORTED>((resolve) => {
		if (combined.aborted) {
			resolve(BOUND_ABORTED);
			return;
		}
		onAbort = () => resolve(BOUND_ABORTED);
		combined.addEventListener("abort", onAbort, { once: true });
	});
	try {
		// The value is boxed so a promise that legitimately resolves `undefined`
		// is still distinguishable from `withDeadline`'s timeout settlement.
		const settled = await withDeadline<{ value: T } | typeof BOUND_ABORTED>(
			Promise.race([
				promise.then((value) => ({ value })),
				aborted as Promise<{ value: T } | typeof BOUND_ABORTED>,
			]),
			{ ms, onTimeout: "undefined" },
		);
		if (settled === undefined || settled === BOUND_ABORTED) {
			// `signal.aborted` is read AFTER the race settled, so it names the
			// bound that actually fired rather than the one that was armed. A
			// reader needs to know whether to raise the budget or to look at why
			// the turn was cancelled — opposite remedies.
			recordDegradationOnce({
				kind: "hook-await-exceeded",
				subject: `${hook}:${label}`,
				reason: signal.aborted
					? `aborted after ${Date.now() - startedAt}ms (budget ${ms}ms)`
					: `exceeded ${ms}ms budget after ${Date.now() - startedAt}ms`,
				metadata: {
					hook,
					label,
					budgetMs: ms,
					elapsedMs: Date.now() - startedAt,
					cause: signal.aborted ? "abort" : "deadline",
				},
			});
			return undefined;
		}
		return settled.value;
	} finally {
		// The hook signal outlives this await by a whole turn, and
		// `AbortSignal.any` keeps the composite alive only while it is
		// referenced — dropping the listener here is what keeps a hook that
		// awaits N times from accumulating N listeners on one turn signal.
		if (onAbort) combined.removeEventListener("abort", onAbort);
	}
}
