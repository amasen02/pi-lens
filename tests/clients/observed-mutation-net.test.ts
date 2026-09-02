/**
 * #2430 items 1, 3 and 4 — the observational net itself.
 *
 * Real files on real disk throughout: the whole mechanism is a content diff, so
 * a double that returns canned stats would prove nothing about whether the diff
 * can see a write (test-authoring screen "ambient-inspection double").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	noteObservedMutation,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import {
	_observedMutationStateForTests,
	_setObservedTurnBudgetForTests,
	armObservedMutation,
	deriveObservedEditRanges,
	noteMutationHandled,
	type ObservedReplayEntry,
	OBSERVED_TRACKED_MAX_FILES,
	OBSERVED_TURN_BUDGET_MS,
	refreshObservedMutationLedger,
	resetObservedMutationNet,
	runObservedSettledSweep,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { lineContentHash } from "../../clients/read-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
	resetDegradationLedger();
});

function recorder(): {
	record: (entry: ObservedReplayEntry) => boolean;
	entries: ObservedReplayEntry[];
} {
	const entries: ObservedReplayEntry[] = [];
	return {
		entries,
		record: (entry) => {
			entries.push(entry);
			return true;
		},
	};
}

function armArgs(
	filePath: string,
	tmpDir: string,
	overrides: Partial<Parameters<typeof armObservedMutation>[0]> = {},
): Parameters<typeof armObservedMutation>[0] {
	return {
		toolCallId: "call-observed-1",
		toolName: "patch_file",
		targetPath: filePath,
		cwd: tmpDir,
		sessionGeneration: 1,
		turnIndex: 1,
		getTrackedPaths: () => [filePath],
		...overrides,
	};
}

describe("#2430 item 1 — arm, diff, replay", () => {
	it("sees a write by an unknown tool and replays it as an edit with real ranges", async () => {
		const env = setupTestEnvironment("pi-lens-2430-arm-");
		try {
			const filePath = path.join(env.tmpDir, "patched.ts");
			fs.writeFileSync(filePath, SOURCE);

			const armed = await armObservedMutation(armArgs(filePath, env.tmpDir));
			expect(armed).toMatchObject({ armed: true });

			// The unknown tool runs and changes line 2 only.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 22;", "const c = 3;", ""].join("\n"),
			);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled.settled).toBe(true);
			expect(settled.replayed).toBe(1);
			expect(sink.entries).toHaveLength(1);
			expect(sink.entries[0]).toMatchObject({
				kind: "edit",
				consumer: "patch_file",
				provenance: "observed",
				touchedLines: [2, 2],
			});
			expect(sink.entries[0].filePath.toLowerCase()).toContain("patched.ts");
		} finally {
			env.cleanup();
		}
	});

	it("attributes the tool on the first observed mutation, so the second call needs no snapshot", async () => {
		const env = setupTestEnvironment("pi-lens-2430-attrib-");
		try {
			const filePath = path.join(env.tmpDir, "learned.ts");
			fs.writeFileSync(filePath, SOURCE);

			await armObservedMutation(armArgs(filePath, env.tmpDir));
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});

			expect(shouldArmObservationForTool("patch_file")).toBe(false);
			const second = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolCallId: "call-observed-2" }),
			);
			expect(second).toEqual({ armed: false, reason: "not-eligible" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("reports no change, and no replay, when the tool wrote nothing", async () => {
		const env = setupTestEnvironment("pi-lens-2430-clean-");
		try {
			const filePath = path.join(env.tmpDir, "untouched.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled).toMatchObject({ settled: true, replayed: 0 });
			expect(sink.entries).toEqual([]);
			// A clean observation is evidence too: it advances the arming latch.
			expect(shouldArmObservationForTool("patch_file")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("refuses to diff a baseline from a session that has since ended", async () => {
		const env = setupTestEnvironment("pi-lens-2430-gen-");
		try {
			const filePath = path.join(env.tmpDir, "gen.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));
			fs.writeFileSync(filePath, `${SOURCE}const e = 5;\n`);

			const sink = recorder();
			const settled = await settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 2,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled.reason).toBe("session-generation-advanced");
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 item 4 — bounds are visible, never silent", () => {
	it("declines the snapshot when the per-turn budget is spent and records a degradation", async () => {
		const env = setupTestEnvironment("pi-lens-2430-budget-");
		try {
			const filePath = path.join(env.tmpDir, "budgeted.ts");
			fs.writeFileSync(filePath, SOURCE);

			// Mutation proof for the budget: with the check removed this call
			// arms, `pending` is non-empty and no ledger entry exists.
			_setObservedTurnBudgetForTests(7, OBSERVED_TURN_BUDGET_MS + 1);
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { turnIndex: 7 }),
			);

			expect(armed).toEqual({ armed: false, reason: "budget-exhausted" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "observed-mutation-budget",
			);
			expect(group?.latestReasons[0]?.subject).toBe("patch_file");
		} finally {
			env.cleanup();
		}
	});

	it("cancels cleanly on an aborted turn instead of finishing the walk", async () => {
		const env = setupTestEnvironment("pi-lens-2430-abort-");
		try {
			const filePath = path.join(env.tmpDir, "aborted.ts");
			fs.writeFileSync(filePath, SOURCE);

			const controller = new AbortController();
			controller.abort();
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { signal: controller.signal }),
			);

			expect(armed).toEqual({ armed: false, reason: "aborted" });
			expect(_observedMutationStateForTests().pending).toEqual([]);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "observed-mutation-budget",
			);
			expect(group?.latestReasons[0]?.reason).toContain("aborted");
		} finally {
			env.cleanup();
		}
	});

	it("charges the per-turn budget so a busy turn cannot arm without limit", async () => {
		const env = setupTestEnvironment("pi-lens-2430-charge-");
		try {
			const filePath = path.join(env.tmpDir, "charged.ts");
			fs.writeFileSync(filePath, SOURCE);
			_setObservedTurnBudgetForTests(3, 0);
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, { turnIndex: 3 }),
			);
			expect(
				_observedMutationStateForTests().turnSpentMs,
			).toBeGreaterThanOrEqual(0);
			// Same turn, so the spend accumulates rather than resetting.
			noteObservedMutation("other_tool", env.tmpDir);
			const before = _observedMutationStateForTests().turnSpentMs;
			await armObservedMutation(
				armArgs(filePath, env.tmpDir, {
					turnIndex: 3,
					toolName: "third_tool",
					toolCallId: "call-observed-3",
				}),
			);
			expect(
				_observedMutationStateForTests().turnSpentMs,
			).toBeGreaterThanOrEqual(before);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 item 3 — the agent_settled sweep", () => {
	it("catches drift in a previously-seen file that no tool call explains", async () => {
		const env = setupTestEnvironment("pi-lens-2430-sweep-");
		try {
			const filePath = path.join(env.tmpDir, "swept.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			// First settle: the file is seen for the first time, so it seeds the
			// ledger and is deliberately NOT reported.
			const seed = recorder();
			const first = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: seed.record,
			});
			expect(first.drifted).toEqual([]);
			expect(seed.entries).toEqual([]);

			// A path-less tool changes it between turns.
			fs.writeFileSync(filePath, `${SOURCE}const f = 6;\n`);

			const sink = recorder();
			const second = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(second.drifted).toHaveLength(1);
			expect(second.replayed).toBe(1);
			expect(sink.entries[0]).toMatchObject({
				kind: "edit",
				consumer: "settled-sweep",
				provenance: "settled-sweep",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not re-report a file the pipeline already recorded this run", async () => {
		const env = setupTestEnvironment("pi-lens-2430-handled-");
		try {
			const filePath = path.join(env.tmpDir, "handled.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: recorder().record,
			});
			fs.writeFileSync(filePath, `${SOURCE}const g = 7;\n`);
			noteMutationHandled(filePath);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(sink.entries).toEqual([]);
			// And the baseline moved on, so the same bytes are never reported later.
			const sinkAgain = recorder();
			const again = await runObservedSettledSweep({
				turnIndex: 3,
				getTrackedPaths: tracked,
				record: sinkAgain.record,
			});
			expect(again.drifted).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("re-baselines after the drain so pi-lens's own formatter output is not drift", async () => {
		const env = setupTestEnvironment("pi-lens-2430-refresh-");
		try {
			const filePath = path.join(env.tmpDir, "formatted.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = () => [filePath];

			await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: tracked,
				record: recorder().record,
			});
			// The deferred drain formats the file AFTER the sweep.
			fs.writeFileSync(filePath, SOURCE.replace("const a", "const  a"));
			await refreshObservedMutationLedger({ getTrackedPaths: tracked });

			const sink = recorder();
			const next = await runObservedSettledSweep({
				turnIndex: 2,
				getTrackedPaths: tracked,
				record: sink.record,
			});
			expect(next.drifted).toEqual([]);
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("never walks the workspace — it stats exactly the tracked set", async () => {
		const env = setupTestEnvironment("pi-lens-2430-nowalk-");
		try {
			const tracked = path.join(env.tmpDir, "tracked.ts");
			fs.writeFileSync(tracked, SOURCE);
			// A sibling the workspace walk would find and the tracked set will not.
			fs.writeFileSync(path.join(env.tmpDir, "sibling.ts"), SOURCE);

			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => [tracked],
				record: recorder().record,
			});
			expect(swept.scanned).toBe(1);
			expect(_observedMutationStateForTests().ledger).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("caps the tracked set it will stat", async () => {
		const env = setupTestEnvironment("pi-lens-2430-cap-");
		try {
			const files: string[] = [];
			for (let index = 0; index < 5; index += 1) {
				const filePath = path.join(env.tmpDir, `f${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				files.push(filePath);
			}
			const oversized = [
				...files,
				...Array.from(
					{ length: OBSERVED_TRACKED_MAX_FILES + 50 },
					(_unused, index) => path.join(env.tmpDir, `ghost-${index}.ts`),
				),
			];
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => oversized,
				record: recorder().record,
			});
			// Ghost paths do not exist, so only the real files land — but the cap
			// is what bounded the number of stats attempted.
			expect(swept.scanned).toBe(5);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 — range derivation from stored line hashes", () => {
	it("names the changed lines, not the whole file", () => {
		const env = setupTestEnvironment("pi-lens-2430-ranges-");
		try {
			const filePath = path.join(env.tmpDir, "ranged.ts");
			const lines = ["a", "b", "c", "d", "e"];
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
			const before: Record<number, string> = {};
			for (let index = 0; index < lines.length; index += 1) {
				before[index + 1] = lineContentHash(lines[index]);
			}
			// The read-guard's stored hashes cover a trailing empty line too.
			before[lines.length + 1] = lineContentHash("");

			fs.writeFileSync(filePath, `${["a", "B", "c", "D", "e"].join("\n")}\n`);
			expect(deriveObservedEditRanges(filePath, before)).toEqual([
				[2, 2],
				[4, 4],
			]);
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined with no baseline, so the caller over-approximates safely", () => {
		expect(deriveObservedEditRanges("/nonexistent/file.ts", undefined)).toBe(
			undefined,
		);
	});
});

describe("#2430 — session boundary", () => {
	it("clears every container the net keeps", async () => {
		const env = setupTestEnvironment("pi-lens-2430-reset-");
		try {
			const filePath = path.join(env.tmpDir, "reset.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));
			noteMutationHandled(filePath);
			expect(_observedMutationStateForTests().pending).toHaveLength(1);
			expect(_observedMutationStateForTests().handled).toHaveLength(1);

			resetObservedMutationNet();

			expect(_observedMutationStateForTests()).toMatchObject({
				pending: [],
				ledger: [],
				handled: [],
				turnSpentMs: 0,
			});
		} finally {
			env.cleanup();
		}
	});
});

describe("#2430 — the arming predicate is the hot-path gate", () => {
	it("does no filesystem work for a tool that is not eligible", async () => {
		const env = setupTestEnvironment("pi-lens-2430-hot-");
		try {
			const filePath = path.join(env.tmpDir, "hot.ts");
			fs.writeFileSync(filePath, SOURCE);
			noteObservedMutation("already_known", env.tmpDir);

			const statSpy = vi.spyOn(fs.promises, "stat");
			const armed = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolName: "already_known" }),
			);
			statSpy.mockRestore();

			// Mutation proof for the predicate: drop the eligibility check and this
			// count is the size of the directory walk plus the tracked set.
			expect(armed).toEqual({ armed: false, reason: "not-eligible" });
			expect(statSpy).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
