/**
 * #2523 slice 2: the private "deadline AND abort signal" implementations are
 * folded onto `clients/deadline-utils.ts#bounded`, and this is what makes the
 * fold LOAD-BEARING rather than cosmetic.
 *
 * Every seam folded here already had both bounds, so a behaviour-only test
 * ("it returns instead of hanging") passes identically before and after — it
 * proves the seam is bounded, not that it is bounded THROUGH the shared
 * primitive, and a reviewer cannot tell a fold from a no-op with it. The
 * assertion that separates the two is the LEDGER: only `bounded()` writes
 * `hook-await-exceeded` naming `<hook>:<label>`. Each hand-rolled copy
 * recorded nothing (`bootstrap#awaitWithinBounds`, `pipeline`'s
 * touch-versus-bail race) or recorded under its own seam-specific kind
 * (`observed-mutation`'s `observed-mutation-budget`), so reverting any one
 * fold turns the matching case below red on a missing subject.
 *
 * Both bounds are asserted per site, not just the deadline: a fold that
 * dropped the signal half would leave the abort case waiting the full budget
 * out, which is the exact regression #2523's probe measured
 * (`still-blocked after 30011ms` with the abort fired at t=2 s).
 *
 * Everything runs through the PRODUCTION entry point — `requestBootstrapClients`,
 * `armObservedMutation` — with the dependency wedged at a real seam (a gated
 * client import, a gated stats capture), never a hand-fed input shaped to hit
 * the bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise } from "../support/fault-injection.js";

type LedgerModule = typeof import("../../clients/degradation-ledger.js");

/**
 * The subject of the most recent `hook-await-exceeded` row, or `undefined`
 * when the kind was never recorded at all.
 *
 * `undefined` is the pre-fold answer for every site here, which is why the
 * assertions read it rather than a count: a hand-rolled race is silent.
 */
function lastExceededSubject(ledger: LedgerModule): string | undefined {
	const group = ledger
		.getDegradationSummary()
		.find((entry) => entry.kind === "hook-await-exceeded");
	return group?.latestReasons.at(-1)?.subject;
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.doUnmock("../../clients/ruff-client.js");
	vi.doUnmock("../../clients/opaque-mutation-scan.js");
	vi.resetModules();
});

describe("#2523 slice 2 — clients/bootstrap.ts#awaitWithinBounds folded onto bounded()", () => {
	/**
	 * Suspend the analyzer build at ONE client module's import. The build
	 * `Promise.all`s all seventeen, so gating any one gates the whole load —
	 * the same seam a genuinely slow filesystem stalls it through, and the
	 * wedge `tests/clients/bootstrap-on-demand.test.ts` already drives this
	 * module with.
	 */
	function gateOneClientImport(): { release: () => void } {
		const gate = gatedPromise<void>();
		vi.doMock("../../clients/ruff-client.js", async (importOriginal) => {
			await gate.promise;
			return await importOriginal<
				typeof import("../../clients/ruff-client.js")
			>();
		});
		return { release: () => gate.resolve(undefined) };
	}

	async function freshBootstrap(): Promise<{
		bootstrap: typeof import("../../clients/bootstrap.js");
		ledger: LedgerModule;
	}> {
		// Imported AFTER the mock and in the same fresh registry, so the ledger
		// this test reads is the one the seam wrote through.
		const ledger = await import("../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const bootstrap = await import("../../clients/bootstrap.js");
		return { bootstrap, ledger };
	}

	it("records hook-await-exceeded naming the demand when the load outlives the wait", async () => {
		const gate = gateOneClientImport();
		const { bootstrap, ledger } = await freshBootstrap();
		try {
			await expect(
				bootstrap.requestBootstrapClients({
					reason: "fold-probe",
					timeoutMs: 40,
				}),
			).resolves.toBeNull();
			// The fold's signature. `awaitWithinBounds` threw a
			// BootstrapUnavailableError and wrote nothing under this kind; the
			// seam's own `analyzer-bootstrap-unavailable` row (asserted below)
			// is a different fact and survived the fold unchanged.
			expect(lastExceededSubject(ledger)).toBe(
				"fold-probe:loadBootstrapClients",
			);
			// The pre-existing seam record is NOT replaced by the new one.
			expect(
				ledger
					.getDegradationSummary()
					.find((e) => e.kind === "analyzer-bootstrap-unavailable")
					?.latestReasons.at(-1)?.reason,
			).toContain("timeout");
		} finally {
			gate.release();
		}
	});

	it("settles on the caller's abort without waiting the budget out, and records nothing", async () => {
		const gate = gateOneClientImport();
		const { bootstrap, ledger } = await freshBootstrap();
		try {
			const caller = new AbortController();
			const startedAt = Date.now();
			const pending = bootstrap.requestBootstrapClients({
				reason: "fold-probe-abort",
				// Long enough that settling on the DEADLINE instead of the signal
				// is unmistakable in the elapsed assertion below.
				timeoutMs: 30_000,
				signal: caller.signal,
			});
			caller.abort();
			await expect(pending).resolves.toBeNull();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			// A caller abort is Escape or a cancelled turn — deliberate, and
			// deliberately absent from the ledger on BOTH the hook-await kind
			// and the seam's own (the `unavailableReason !== "aborted"` guard).
			expect(lastExceededSubject(ledger)).toBeUndefined();
			expect(ledger.getDegradationSummary()).toEqual([]);
		} finally {
			gate.release();
		}
	});
});

describe("#2523 slice 2 — clients/observed-mutation.ts#withBounds folded onto bounded()", () => {
	/**
	 * Wedge the arm's stats capture. `collectObservationUniverse` runs first
	 * and touches the filesystem directly, so the wedge sits INSIDE the bound
	 * rather than in front of it.
	 */
	function gateStatsCapture(): { release: () => void } {
		const gate = gatedPromise<void>();
		vi.doMock(
			"../../clients/opaque-mutation-scan.js",
			async (importOriginal) => {
				const actual =
					await importOriginal<
						typeof import("../../clients/opaque-mutation-scan.js")
					>();
				return {
					...actual,
					captureFileStatsForPaths: async () => {
						await gate.promise;
						return { snapshot: new Map(), stoppedEarly: false };
					},
				};
			},
		);
		return { release: () => gate.resolve(undefined) };
	}

	it("records hook-await-exceeded naming the arm when the capture outlives its budget", async () => {
		const gate = gateStatsCapture();
		const ledger = await import("../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const observed = await import("../../clients/observed-mutation.js");
		const attribution = await import("../../clients/mutation-attribution.js");
		observed.resetObservedMutationNet();
		attribution.resetMutationAttribution();
		try {
			const armed = await observed.armObservedMutation({
				toolCallId: "fold-probe-call",
				toolName: "patch_file",
				targetPath: "does-not-need-to-exist.ts",
				cwd: process.cwd(),
				sessionGeneration: 1,
				turnIndex: 1,
			});
			expect(armed).toMatchObject({ armed: false });
			expect(lastExceededSubject(ledger)).toBe("tool_call:armObservedMutation");
		} finally {
			gate.release();
		}
	});

	it("reports `aborted`, not `timeout`, when the signal fires mid-capture", async () => {
		// The compiler narrows `signal?.aborted` to `false` after the pre-flight
		// check, so reading it inline after the await would fold this branch to
		// "timeout" and silently reclassify every mid-capture abort. Deleting
		// the `isAborted()` indirection turns this case red.
		const gate = gateStatsCapture();
		const ledger = await import("../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const observed = await import("../../clients/observed-mutation.js");
		const attribution = await import("../../clients/mutation-attribution.js");
		observed.resetObservedMutationNet();
		attribution.resetMutationAttribution();
		try {
			const caller = new AbortController();
			const pending = observed.armObservedMutation({
				toolCallId: "fold-probe-abort",
				toolName: "patch_file",
				targetPath: "does-not-need-to-exist.ts",
				cwd: process.cwd(),
				sessionGeneration: 1,
				turnIndex: 1,
				signal: caller.signal,
			});
			caller.abort();
			await expect(pending).resolves.toMatchObject({
				armed: false,
				reason: "aborted",
			});
			// A caller abort is not a blown budget.
			expect(lastExceededSubject(ledger)).toBeUndefined();
		} finally {
			gate.release();
		}
	});
});
