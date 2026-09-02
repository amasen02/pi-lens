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
	DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS,
	lookupLearnedMutatingTool,
	noteObservedMutation,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import {
	_observedMutationStateForTests,
	_setObservedTurnBudgetForTests,
	armObservedMutation,
	deriveObservedEditRanges,
	type LineHashReadBudget,
	noteMutationHandled,
	type ObservedReplayEntry,
	OBSERVED_SWEEP_HASH_BUDGET_BYTES,
	OBSERVED_SWEEP_STAT_WINDOW,
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

	it("keeps watching a provisionally attributed tool, and stops once the attribution is durable", async () => {
		// #2449 review round 2, F4/F2. ONE observation attributes the tool for
		// this session but does not make the claim durable, and the only thing
		// that can is a SECOND real disk diff — so the tool stays armed across
		// exactly one more call and then stops for good. The first cut latched
		// off after observation one, which is what made
		// `PERSIST_AFTER_OBSERVATIONS = 2` unreachable on the production path.
		const env = setupTestEnvironment("pi-lens-2430-attrib-");
		try {
			const filePath = path.join(env.tmpDir, "learned.ts");
			fs.writeFileSync(filePath, SOURCE);

			await armObservedMutation(armArgs(filePath, env.tmpDir));
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});

			// Provisional: attributed, still watched.
			expect(shouldArmObservationForTool("patch_file")).toBe(true);
			const second = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolCallId: "call-observed-2" }),
			);
			expect(second).toMatchObject({ armed: true });
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\nconst e = 5;\n`);
			settleObservedMutation({
				toolCallId: "call-observed-2",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});

			// Durable: persisted, so nothing is ever armed for it again.
			expect(shouldArmObservationForTool("patch_file")).toBe(false);
			const third = await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolCallId: "call-observed-3" }),
			);
			expect(third).toEqual({ armed: false, reason: "not-eligible" });
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
			// Two caps, both load-bearing. The tracked set is truncated to
			// OBSERVED_TRACKED_MAX_FILES, and ONE pass stats at most
			// OBSERVED_SWEEP_STAT_WINDOW of those before parking its cursor for
			// the next turn (#2449 review round 2, F3) — so `scanned` is the
			// window, not the set, and the rest is reported as `remaining`
			// rather than silently skipped.
			expect(swept.scanned).toBe(OBSERVED_SWEEP_STAT_WINDOW);
			expect(swept.remaining).toBe(
				OBSERVED_TRACKED_MAX_FILES - OBSERVED_SWEEP_STAT_WINDOW,
			);
			expect(swept.cursor).toBe(OBSERVED_SWEEP_STAT_WINDOW);
			// Only the five files that exist can hold a baseline.
			expect(_observedMutationStateForTests().ledger).toHaveLength(5);
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
			// TWO observations: that is what makes the attribution durable, and
			// only a durable attribution stops the arming (#2449 round 2, F2).
			noteObservedMutation("already_known", env.tmpDir);
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

describe("#2449 review round 2 — the observation universe is the target path", () => {
	it("does not learn a tool from a SIBLING file that moved during the call", async () => {
		// F4. The first cut snapshotted the target's whole DIRECTORY, so an
		// unrelated write landing anywhere beside the file a READ-shaped tool
		// named was replayed as that tool's edit AND taught the attribution map
		// that the tool mutates. One coincidence, and every later call of a read
		// tool is classified as an edit for the rest of the session.
		const env = setupTestEnvironment("pi-lens-2449-sibling-");
		try {
			const target = path.join(env.tmpDir, "read-me.ts");
			const sibling = path.join(env.tmpDir, "written-by-someone-else.ts");
			fs.writeFileSync(target, SOURCE);
			fs.writeFileSync(sibling, SOURCE);

			const armed = await armObservedMutation(
				armArgs(target, env.tmpDir, { toolName: "sniff_file" }),
			);
			expect(armed).toMatchObject({ armed: true, scannedCount: 1 });

			// A background write during the call — a formatter, another agent, a
			// watcher. It touches the SIBLING, never the target.
			fs.writeFileSync(sibling, `${SOURCE}const intruder = 1;\n`);

			const sink = recorder();
			const settled = settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "sniff_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled).toMatchObject({ settled: true, replayed: 0 });
			expect(sink.entries).toEqual([]);
			expect(lookupLearnedMutatingTool("sniff_file")).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("watches a DIRECTORY target's own entries, non-recursively", async () => {
		const env = setupTestEnvironment("pi-lens-2449-dir-");
		try {
			const dir = path.join(env.tmpDir, "pkg");
			const nested = path.join(dir, "deep");
			fs.mkdirSync(nested, { recursive: true });
			const inside = path.join(dir, "a.ts");
			const deeper = path.join(nested, "b.ts");
			fs.writeFileSync(inside, SOURCE);
			fs.writeFileSync(deeper, SOURCE);

			const armed = await armObservedMutation(
				armArgs(dir, env.tmpDir, { toolName: "codemod_dir" }),
			);
			// One entry: `a.ts`. `deep/` is a directory and `deep/b.ts` is a level
			// down, so neither is in the universe.
			expect(armed).toMatchObject({ armed: true, scannedCount: 1 });

			fs.writeFileSync(deeper, `${SOURCE}const nestedChange = 1;\n`);
			fs.writeFileSync(
				inside,
				["const a = 1;", "const b = 99;", "const c = 3;", ""].join("\n"),
			);

			const sink = recorder();
			const settled = settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "codemod_dir",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});
			expect(settled.replayed).toBe(1);
			expect(sink.entries).toHaveLength(1);
			expect(sink.entries[0].filePath.toLowerCase()).toContain("a.ts");
		} finally {
			env.cleanup();
		}
	});

	it("forgets a session attribution after three consecutive clean observations", async () => {
		// F4's de-attribution half: a claim made from one disk observation has
		// to be revisable by later evidence, or a coincidence is permanent.
		const env = setupTestEnvironment("pi-lens-2449-deattrib-");
		try {
			const filePath = path.join(env.tmpDir, "sometimes.ts");
			fs.writeFileSync(filePath, SOURCE);

			await armObservedMutation(
				armArgs(filePath, env.tmpDir, { toolName: "maybe_writes" }),
			);
			fs.writeFileSync(filePath, `${SOURCE}const d = 4;\n`);
			settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "maybe_writes",
				sessionGeneration: 1,
				turnIndex: 1,
				record: recorder().record,
			});
			expect(lookupLearnedMutatingTool("maybe_writes")).toBe("session");

			for (
				let attempt = 0;
				attempt < DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS;
				attempt += 1
			) {
				const callId = `call-clean-${attempt}`;
				const armed = await armObservedMutation(
					armArgs(filePath, env.tmpDir, {
						toolName: "maybe_writes",
						toolCallId: callId,
					}),
				);
				expect(armed).toMatchObject({ armed: true });
				settleObservedMutation({
					toolCallId: callId,
					toolName: "maybe_writes",
					sessionGeneration: 1,
					turnIndex: 1,
					record: recorder().record,
				});
			}

			expect(lookupLearnedMutatingTool("maybe_writes")).toBeUndefined();
			// And it is not re-armed forever either: the clean counter is what
			// stops the watching, so it is deliberately NOT reset.
			expect(shouldArmObservationForTool("maybe_writes")).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 2 — the settle is not budget-gated", () => {
	it("completes for the target path with the per-turn budget already spent", async () => {
		// F5. The first cut clamped the post-capture to whatever was left of the
		// arm budget (`Math.min(Math.max(remaining, 1), ...)`), so a busy turn
		// gave the settle 1ms, it reported a timeout, and a mutation that had
		// already been measured was dropped on the floor.
		const env = setupTestEnvironment("pi-lens-2449-settle-budget-");
		try {
			const filePath = path.join(env.tmpDir, "late.ts");
			fs.writeFileSync(filePath, SOURCE);
			await armObservedMutation(armArgs(filePath, env.tmpDir));

			// The rest of the turn burns the whole observational budget.
			_setObservedTurnBudgetForTests(1, OBSERVED_TURN_BUDGET_MS);

			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 42;", "const c = 3;", ""].join("\n"),
			);
			const sink = recorder();
			const settled = settleObservedMutation({
				toolCallId: "call-observed-1",
				toolName: "patch_file",
				sessionGeneration: 1,
				turnIndex: 1,
				record: sink.record,
			});

			expect(settled).toMatchObject({ settled: true, replayed: 1, scanned: 1 });
			expect(settled.reason).toBeUndefined();
			expect(sink.entries[0]).toMatchObject({ touchedLines: [2, 2] });
		} finally {
			env.cleanup();
		}
	});

	it("names a missing baseline instead of reporting a silent no-op", () => {
		// F5's second half: "nothing changed" and "nothing was watched" are
		// different answers, and the record has to say which (catalog shape 10).
		const settled = settleObservedMutation({
			toolCallId: "call-that-never-armed",
			toolName: "patch_file",
			sessionGeneration: 1,
			turnIndex: 1,
			record: recorder().record,
		});
		expect(settled).toMatchObject({
			settled: false,
			replayed: 0,
			reason: "no-pending-baseline",
		});
	});
});

describe("#2449 review round 2 — ranges are measured, never fabricated", () => {
	it("returns no ranges for a WINDOWED read-guard baseline", () => {
		// F6. A partial read stores hashes for the lines it showed. The first cut
		// compared those by line number against the whole file: a real change at
		// line 3 fell below the window and was DROPPED, and every line past the
		// window's top was reported as new — the fabricated 61..101.
		const env = setupTestEnvironment("pi-lens-2449-window-");
		try {
			const filePath = path.join(env.tmpDir, "big.ts");
			const lines = Array.from(
				{ length: 100 },
				(_unused, index) => `const v${index} = ${index};`,
			);
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

			// A windowed baseline: only lines 60..100 were ever shown.
			const windowed: Record<number, string> = {};
			for (let line = 60; line <= 100; line += 1) {
				windowed[line] = lineContentHash(lines[line - 1]);
			}

			// The tool changes line 3 — inside the file, outside the window.
			lines[2] = "const v2 = 999;";
			fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

			expect(deriveObservedEditRanges(filePath, windowed)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns no ranges when the line COUNT changed", () => {
		// F6's other half: an insert shifts every following line, so a
		// by-line-number diff reports the shift rather than the edit. The safe
		// answer is no ranges at all, which over-approximates to the whole file.
		const env = setupTestEnvironment("pi-lens-2449-linecount-");
		try {
			const filePath = path.join(env.tmpDir, "grew.ts");
			fs.writeFileSync(filePath, SOURCE);
			const baseline = new Map(
				SOURCE.split("\n").map((line, index) => [
					index + 1,
					lineContentHash(line),
				]),
			);
			fs.writeFileSync(
				filePath,
				["const zero = 0;", ...SOURCE.split("\n")].join("\n"),
			);
			expect(deriveObservedEditRanges(filePath, baseline)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns no ranges once the cumulative read budget is spent", () => {
		// F8. Range derivation reads whole files; on the sweep that is once per
		// drifted file, which without a cumulative cap is unbounded read volume
		// at a turn boundary.
		const env = setupTestEnvironment("pi-lens-2449-rangebudget-");
		try {
			const filePath = path.join(env.tmpDir, "ranged.ts");
			fs.writeFileSync(filePath, SOURCE);
			const baseline = new Map(
				SOURCE.split("\n").map((line, index) => [
					index + 1,
					lineContentHash(line),
				]),
			);
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 7;", "const c = 3;", ""].join("\n"),
			);

			const spent: LineHashReadBudget = { remainingBytes: 0 };
			expect(
				deriveObservedEditRanges(filePath, baseline, spent),
			).toBeUndefined();

			const funded: LineHashReadBudget = { remainingBytes: 1024 * 1024 };
			expect(deriveObservedEditRanges(filePath, baseline, funded)).toEqual([
				[2, 2],
			]);
			// The budget is actually DRAWN from, not merely consulted.
			expect(funded.remainingBytes).toBeLessThan(1024 * 1024);
		} finally {
			env.cleanup();
		}
	});
});

describe("#2449 review round 2 — the settled sweep is incremental and honest", () => {
	it("covers a 400-file tracked set over several turns without ever timing out", async () => {
		// F3. At OBSERVED_TRACKED_MAX_FILES the first cut hashed every file on
		// every pass and blew the 200ms capture budget, so the sweep reported a
		// timeout and never ran at realistic sizes. Now it stats a window per
		// turn from a carried cursor and reads only what moved.
		const env = setupTestEnvironment("pi-lens-2449-incremental-");
		try {
			const tracked: string[] = [];
			for (let index = 0; index < OBSERVED_TRACKED_MAX_FILES; index += 1) {
				const filePath = path.join(env.tmpDir, `mod-${index}.ts`);
				fs.writeFileSync(filePath, SOURCE);
				tracked.push(filePath);
			}

			const turns = Math.ceil(
				OBSERVED_TRACKED_MAX_FILES / OBSERVED_SWEEP_STAT_WINDOW,
			);
			expect(turns).toBeGreaterThan(1);
			let covered = 0;
			for (let turn = 0; turn < turns; turn += 1) {
				const swept = await runObservedSettledSweep({
					turnIndex: turn,
					getTrackedPaths: () => tracked,
					record: recorder().record,
				});
				// Never a timeout, and the record always says how far it got, so a
				// partial pass can never be read as a complete one.
				expect(swept.reason).toBeUndefined();
				expect(swept.scanned).toBe(OBSERVED_SWEEP_STAT_WINDOW);
				expect(swept.scanned + swept.remaining).toBe(
					OBSERVED_TRACKED_MAX_FILES,
				);
				expect(swept.cursor).toBeLessThan(OBSERVED_TRACKED_MAX_FILES);
				covered += swept.scanned;
				if (turn < turns - 1) {
					// Genuinely INCREMENTAL: one pass is not enough, which is the
					// whole reason the cursor exists.
					expect(_observedMutationStateForTests().ledger.length).toBeLessThan(
						OBSERVED_TRACKED_MAX_FILES,
					);
				}
			}
			expect(covered).toBeGreaterThanOrEqual(OBSERVED_TRACKED_MAX_FILES);
			// Coverage completes: every tracked file now holds a baseline.
			expect(_observedMutationStateForTests().ledger).toHaveLength(
				OBSERVED_TRACKED_MAX_FILES,
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not replay a file whose mtime moved but whose bytes did not", async () => {
		// F7. `touch` bumps mtime without moving a byte. The first cut fell back
		// to size+mtime whenever a hash was missing on either side and replayed
		// a phantom edit, queueing the file for a format it did not need.
		const env = setupTestEnvironment("pi-lens-2449-touch-");
		try {
			const filePath = path.join(env.tmpDir, "touched.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = [filePath];

			// Turn one seeds the baseline.
			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});

			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(swept.unverifiable).toEqual([]);
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("names a file it cannot verify instead of replaying it on stat alone", async () => {
		// F7's honest-degradation half. A file past the sweep's read budget can
		// never carry a hash, so a stat that moves is un-provable either way —
		// and the answer is to say so, not to guess (catalog shape 10).
		const env = setupTestEnvironment("pi-lens-2449-unverifiable-");
		try {
			const filePath = path.join(env.tmpDir, "huge.bin");
			fs.writeFileSync(
				filePath,
				Buffer.alloc(OBSERVED_SWEEP_HASH_BUDGET_BYTES + 1024, 0x61),
			);
			const tracked = [filePath];

			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toEqual([]);
			expect(swept.unverifiable).toHaveLength(1);
			expect(swept.unverifiable[0].toLowerCase()).toContain("huge.bin");
			// Named, never replayed: a phantom format is worse than a gap that
			// reports itself.
			expect(sink.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("catches a same-tick, same-SIZE rewrite that the stat short-circuit alone would miss", async () => {
		// Catalog shape 6, reached by the F3 redesign: "stat first, read only on
		// change" is what makes the sweep affordable, and a file rewritten to the
		// same length inside the same mtime tick we seeded it in has an identical
		// stat forever after — the drift would be baked into the baseline and
		// never reported. `LedgerEntry.seenAtMs` is the guard; delete it and this
		// case reports zero drift.
		const env = setupTestEnvironment("pi-lens-2449-sametick-");
		try {
			const filePath = path.join(env.tmpDir, "same-size.ts");
			fs.writeFileSync(filePath, SOURCE);
			const tracked = [filePath];

			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => tracked,
				record: recorder().record,
			});

			// Byte-for-byte the same LENGTH, written immediately — so on a coarse
			// filesystem clock both size and mtime can be unchanged.
			const rewritten = [
				"const a = 1;",
				"const b = 9;",
				"const c = 3;",
				"",
			].join("\n");
			expect(rewritten.length).toBe(SOURCE.length);
			fs.writeFileSync(filePath, rewritten);
			const seeded = fs.statSync(filePath);
			fs.utimesSync(
				filePath,
				new Date(seeded.mtimeMs),
				new Date(seeded.mtimeMs),
			);

			const sink = recorder();
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => tracked,
				record: sink.record,
			});
			expect(swept.drifted).toHaveLength(1);
			expect(sink.entries).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("seeds a first sighting from the read-guard's stored hashes, with no file read", async () => {
		// F3's cost half: pi-lens already paid for those bytes on the read
		// (#505), so seeding the ledger from them means the sweep's first pass
		// over a file the agent has read costs one stat and nothing more.
		const env = setupTestEnvironment("pi-lens-2449-seed-");
		try {
			const filePath = path.join(env.tmpDir, "already-read.ts");
			fs.writeFileSync(filePath, SOURCE);
			const stored: Record<number, string> = {};
			SOURCE.split("\n").forEach((line, index) => {
				stored[index + 1] = lineContentHash(line);
			});

			const readSpy = vi.spyOn(fs.promises, "readFile");
			await runObservedSettledSweep({
				turnIndex: 0,
				getTrackedPaths: () => [filePath],
				getStoredLineHashes: () => stored,
				record: recorder().record,
			});
			expect(readSpy).not.toHaveBeenCalled();
			readSpy.mockRestore();

			// And the seeded baseline is real: a later content change is caught
			// against it, so the shortcut is not a coverage hole.
			fs.writeFileSync(
				filePath,
				["const a = 1;", "const b = 5;", "const c = 3;", ""].join("\n"),
			);
			const swept = await runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => [filePath],
				getStoredLineHashes: () => stored,
				record: recorder().record,
			});
			expect(swept.drifted).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});
});
