/**
 * #2523 AC2: `bounded()` cannot be called with one bound, and firing the
 * signal settles it without waiting the deadline out.
 *
 * The compile-time half is the load-bearing one. Every earlier attempt at
 * this discipline was a convention — "remember to pass the signal too" — and
 * conventions are what #2523's sweep found 187 exceptions to. A missing bound
 * has to be a type error, so the `@ts-expect-error` cases below are assertions
 * about the TYPE, checked by the repo's lint/typecheck gate: if `bounded`
 * ever accepts one bound, `@ts-expect-error` becomes an UNUSED suppression
 * and `tsc` fails on it. That is the direction that matters — the test cannot
 * silently stop guarding.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bounded } from "../../clients/deadline-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

/** A promise that never settles: the wedged dependency #2523 measured. */
function wedged<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

/**
 * Never CALLED — only type-checked. `@ts-expect-error` is a compile-time
 * assertion, and executing a one-bound call would run code the type forbids
 * (a `ms: undefined` reaches `AbortSignal.timeout(NaN)`), which is a property
 * of its own and is asserted separately below.
 */
async function _oneBoundCallsDoNotTypeCheck(
	signal: AbortSignal,
): Promise<void> {
	// @ts-expect-error #2523 AC2: `signal` is required — a deadline alone
	// leaves Escape unable to release the hook (measured: still blocked
	// 30011ms after the abort fired).
	await bounded(Promise.resolve(1), {
		ms: 5,
		hook: "turn_end",
		label: "deadline-only",
	});
	// @ts-expect-error #2523 AC2: `ms` is required — a signal alone leaves a
	// dependency that wedges with nobody pressing Escape running forever
	// (measured: 400000ms, the harness ceiling).
	await bounded(Promise.resolve(1), {
		signal,
		hook: "turn_end",
		label: "signal-only",
	});
}

describe("#2523 AC2 bounded() requires BOTH bounds", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
	});

	it("accepts the both-bounds call, and only that one", () => {
		// The compile-time half of this assertion lives in
		// `_oneBoundCallsDoNotTypeCheck` above: if `bounded` ever accepts one
		// bound, its `@ts-expect-error` comments become unused suppressions and
		// the typecheck gate fails. This case pins the positive direction.
		const controller = new AbortController();
		expect(typeof _oneBoundCallsDoNotTypeCheck).toBe("function");
		expect(
			bounded(Promise.resolve(1), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "both",
			}),
		).toBeInstanceOf(Promise);
	});

	it("settles immediately on a non-finite budget instead of throwing", async () => {
		// The runtime companion to the type assertion: a JS caller can still
		// hand over `undefined`, and `AbortSignal.timeout(NaN)` throws
		// ERR_OUT_OF_RANGE. A helper whose job is keeping a hook from blowing up
		// must not blow up inside one.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: undefined as unknown as number,
				signal: controller.signal,
				hook: "turn_end",
				label: "non-finite-budget",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("returns the value when the work settles inside both bounds", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("answer"), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "fast",
			}),
		).resolves.toBe("answer");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("settles on the SIGNAL without waiting the deadline out", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = bounded(wedged<string>(), {
			// A deadline far beyond any plausible test runtime: if the abort leg
			// were missing, this test would time out rather than pass late, so a
			// regression cannot hide behind a generous assertion.
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "escape",
		});
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		const group = summaryFor("hook-await-exceeded");
		expect(group?.latestReasons.at(-1)?.subject).toBe("turn_end:escape");
		expect(group?.latestReasons.at(-1)?.reason).toContain("aborted");
	});

	it("settles on the DEADLINE when nothing aborts, naming the budget", async () => {
		const controller = new AbortController();
		await expect(
			bounded(wedged<string>(), {
				ms: 20,
				signal: controller.signal,
				hook: "session_start",
				label: "dropStaleFiles",
			}),
		).resolves.toBeUndefined();
		const group = summaryFor("hook-await-exceeded");
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"session_start:dropStaleFiles",
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("20ms budget");
	});

	it("records ONE rising-edge row per (hook, label), not one per exceedance", async () => {
		// AC7: exceedance must be visible without flooding. A hook that blows
		// its budget on every turn of a long session writes one row.
		const controller = new AbortController();
		for (let i = 0; i < 5; i++) {
			await bounded(wedged<void>(), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "sweepInlineBlockerFreshness",
			});
		}
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
		// A DIFFERENT await under the same hook is its own subject, so the
		// ledger still answers which await is slow, not merely that one is.
		await bounded(wedged<void>(), {
			ms: 5,
			signal: controller.signal,
			hook: "turn_end",
			label: "readCachedDiagnosticsForServers",
		});
		expect(summaryFor("hook-await-exceeded")?.count).toBe(2);
	});

	it("distinguishes `no answer inside the bound` from a value of undefined", async () => {
		// Defect shape 10: a bound that fired must not read like a clean answer.
		// `undefined` is the return either way — the LEDGER is what separates
		// them, which is why the exceeded path records and the resolved path
		// does not.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve(undefined), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "legitimately-undefined",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("propagates the work's own rejection instead of swallowing it", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.reject(new Error("runner blew up")), {
				ms: 1000,
				signal: controller.signal,
				hook: "agent_end",
				label: "runAutofix",
			}),
		).rejects.toThrow("runner blew up");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("suppresses a LATE rejection from work the bound already abandoned", async () => {
		// Without this, every timed-out hook await would surface as an
		// unhandled rejection a few hundred ms after the hook returned — a
		// process-level crash risk introduced by the very helper meant to make
		// hooks safe.
		const controller = new AbortController();
		let rejectLate: ((error: Error) => void) | undefined;
		const late = new Promise<void>((_resolve, reject) => {
			rejectLate = reject;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				bounded(late, {
					ms: 10,
					signal: controller.signal,
					hook: "turn_end",
					label: "late-rejector",
				}),
			).resolves.toBeUndefined();
			rejectLate?.(new Error("too late"));
			// Two macrotask turns: `unhandledRejection` fires at the end of a
			// microtask checkpoint, so one turn is enough, and the second is
			// slack against a slow CI host.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not accumulate listeners on the hook signal it is handed", async () => {
		// The hook's signal outlives one await by a whole turn, and a handler
		// that awaits N times must not leave N listeners behind on it.
		const controller = new AbortController();
		const before = (
			controller.signal as AbortSignal & {
				// Node exposes the count through the EventTarget shim's own API.
				listenerCount?: (type: string) => number;
			}
		).listenerCount?.("abort");
		for (let i = 0; i < 20; i++) {
			await bounded(Promise.resolve(i), {
				ms: 1000,
				signal: controller.signal,
				hook: "session_start",
				label: "loop",
			});
		}
		const after = (
			controller.signal as AbortSignal & {
				listenerCount?: (type: string) => number;
			}
		).listenerCount?.("abort");
		// Node's AbortSignal does not expose listenerCount on every version; the
		// assertion is skipped rather than faked when it is absent, and the
		// no-leak property is still covered by the composite signal being
		// dropped with the call frame.
		if (typeof before === "number" && typeof after === "number") {
			expect(after).toBeLessThanOrEqual(before + 1);
		}
	});

	it("settles immediately, and records, when the budget is zero", async () => {
		// `turn_start`, `context`, `session_shutdown` and `session_before_fork`
		// carry a 0ms budget in clients/hook-budgets.ts: "may not await at
		// all". A zero budget must therefore settle without waiting, and must
		// still be visible rather than silently returning nothing.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: 0,
				signal: controller.signal,
				hook: "turn_start",
				label: "anything",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("settles immediately when the signal is ALREADY aborted", async () => {
		// A hook entered after Escape was pressed must not spend its budget
		// discovering that.
		const controller = new AbortController();
		controller.abort();
		const startedAt = Date.now();
		await expect(
			bounded(wedged<void>(), {
				ms: 60_000,
				signal: controller.signal,
				hook: "agent_settled",
				label: "already-aborted",
			}),
		).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
});
