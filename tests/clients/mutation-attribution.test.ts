/**
 * #2430 item 2 — auto-attribution for tools the seam cannot classify.
 *
 * Every case here drives the real modules through their `.js` specifiers (the
 * artifact the runtime imports, catalog shape 14) and asserts on real disk
 * state under a temp `PILENS_DATA_DIR`, so nothing passes because a `.ts`
 * import handed the test its own private copy of the module's maps.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	CLEAN_OBSERVATION_ARM_LIMIT,
	DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS,
	isProvisionalLearnedAttribution,
	MUTATION_ATTRIBUTION_FILE,
	lookupLearnedMutatingTool,
	noteObservedClean,
	noteObservedMutation,
	primePersistedMutationAttribution,
	resetMutationAttribution,
	shouldArmObservationForTool,
} from "../../clients/mutation-attribution.js";
import { classifyMutatingTool } from "../../clients/mutating-tool.js";
import { setupTestEnvironment } from "./test-utils.js";

beforeEach(() => {
	resetMutationAttribution();
	resetDegradationLedger();
});

function unknownToolEvent(filePath: string): Record<string, unknown> {
	return {
		toolName: "patch_file",
		toolCallId: "call-attrib-1",
		input: { path: filePath, body: "whatever" },
		content: [{ type: "text", text: "patched" }],
	};
}

describe("#2430 item 2 — session attribution", () => {
	it("classifies an unknown tool as a learned mutation after ONE observation", () => {
		const event = unknownToolEvent("/tmp/x.ts");
		expect(classifyMutatingTool(event)).toBeUndefined();

		noteObservedMutation("patch_file", undefined);

		expect(lookupLearnedMutatingTool("patch_file")).toBe("session");
		const classified = classifyMutatingTool(event);
		expect(classified).toMatchObject({
			toolName: "patch_file",
			kind: "edit",
			provenance: "learned",
			source: "attribution:session",
			path: "/tmp/x.ts",
		});
	});

	it("does NOT classify a learned tool whose call names no file", () => {
		noteObservedMutation("patch_file", undefined);
		// No path-shaped field: there is no target to record, so the settled
		// sweep owns this shape, not the classifier.
		expect(
			classifyMutatingTool({ toolName: "patch_file", input: { body: "x" } }),
		).toBeUndefined();
	});

	it("records exactly one `unclassified-mutating-tool` degradation per tool", () => {
		noteObservedMutation("patch_file", undefined);
		noteObservedMutation("patch_file", undefined);
		noteObservedMutation("other_tool", undefined);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "unclassified-mutating-tool",
		);
		expect(group).toBeDefined();
		expect(group?.latestReasons.map((entry) => entry.subject).sort()).toEqual([
			"other_tool",
			"patch_file",
		]);
	});
});

describe("#2430 item 2 — the arming predicate", () => {
	it("arms an unknown tool, keeps arming it while provisional, and stops once durable", () => {
		// The three-state predicate (#2449 review round 2, F2), and a mutation
		// proof for each boundary: a predicate hard-wired `true` fails the last
		// assertion, one hard-wired `false` fails the first, and one that
		// latches off after the FIRST observation — the shipped bug — fails the
		// middle one and makes PERSIST_AFTER_OBSERVATIONS unreachable.
		expect(shouldArmObservationForTool("patch_file")).toBe(true);
		noteObservedMutation("patch_file", undefined);
		expect(shouldArmObservationForTool("patch_file")).toBe(true);
		expect(isProvisionalLearnedAttribution("patch_file")).toBe(true);
		noteObservedMutation("patch_file", undefined);
		expect(shouldArmObservationForTool("patch_file")).toBe(false);
		expect(isProvisionalLearnedAttribution("patch_file")).toBe(false);
	});

	it("stops arming after the clean-observation limit, and not before", () => {
		// Mutation proof: the limit is load-bearing in BOTH directions. A
		// predicate hard-wired to `true` fails the last assertion; one hard-wired
		// to `false` fails the first two; an off-by-one fails one of the middle
		// two.
		expect(CLEAN_OBSERVATION_ARM_LIMIT).toBe(2);
		expect(shouldArmObservationForTool("grep_like")).toBe(true);
		noteObservedClean("grep_like");
		expect(shouldArmObservationForTool("grep_like")).toBe(true);
		noteObservedClean("grep_like");
		expect(shouldArmObservationForTool("grep_like")).toBe(false);
	});

	it("re-arms a tool whose clean run is followed by a real mutation", () => {
		noteObservedClean("sometimes_writes");
		noteObservedMutation("sometimes_writes", undefined);
		// Attributed now — and the clean counter was reset rather than left to
		// latch the tool off on its next quiet call.
		expect(lookupLearnedMutatingTool("sometimes_writes")).toBe("session");
	});

	it("withdraws a provisional attribution after three consecutive clean runs", () => {
		// #2449 review round 2, F4. One observation is one piece of evidence,
		// and evidence has to be revisable: three armed observations in a row
		// where nothing moved say the first was a coincidence.
		expect(DEATTRIBUTE_AFTER_CLEAN_OBSERVATIONS).toBe(3);
		noteObservedMutation("coincidence", undefined);
		expect(lookupLearnedMutatingTool("coincidence")).toBe("session");
		noteObservedClean("coincidence");
		noteObservedClean("coincidence");
		// Off-by-one guard: two is not enough.
		expect(lookupLearnedMutatingTool("coincidence")).toBe("session");
		noteObservedClean("coincidence");
		expect(lookupLearnedMutatingTool("coincidence")).toBeUndefined();
		expect(isProvisionalLearnedAttribution("coincidence")).toBe(false);
		// The clean counter is NOT reset by the withdrawal, so the tool does not
		// go straight back to being armed on every call.
		expect(shouldArmObservationForTool("coincidence")).toBe(false);
	});

	it("never withdraws an attribution that already reached disk", () => {
		const env = setupTestEnvironment("pi-lens-2449-durable-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			noteObservedMutation("real_writer", env.tmpDir);
			noteObservedMutation("real_writer", env.tmpDir);
			expect(lookupLearnedMutatingTool("real_writer")).toBe("session");
			for (let run = 0; run < 10; run += 1) noteObservedClean("real_writer");
			// Two observations earned persistence; clean runs after that cannot
			// un-learn it, and nothing arms for it either way.
			expect(lookupLearnedMutatingTool("real_writer")).toBe("session");
			expect(shouldArmObservationForTool("real_writer")).toBe(false);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2430 item 2 — persistence across sessions", () => {
	it("persists on the SECOND observation and a fresh session classifies from disk", () => {
		const env = setupTestEnvironment("pi-lens-2430-persist-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const first = noteObservedMutation("patch_file", env.tmpDir);
			expect(first).toMatchObject({ observations: 1, persisted: false });

			const second = noteObservedMutation("patch_file", env.tmpDir);
			expect(second).toMatchObject({ observations: 2, persisted: true });

			const file = path.join(
				getProjectDataDir(env.tmpDir),
				MUTATION_ATTRIBUTION_FILE,
			);
			expect(fs.existsSync(file)).toBe(true);
			expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({
				version: 1,
				tools: [{ name: "patch_file", observations: 2 }],
			});

			// A FRESH session: everything in memory is gone, and the only thing
			// left is the file on disk.
			resetMutationAttribution();
			expect(lookupLearnedMutatingTool("patch_file")).toBeUndefined();

			primePersistedMutationAttribution(env.tmpDir);
			expect(lookupLearnedMutatingTool("patch_file")).toBe("persisted");
			expect(shouldArmObservationForTool("patch_file")).toBe(false);
			expect(
				classifyMutatingTool({
					toolName: "patch_file",
					input: { path: "/tmp/y.ts" },
				}),
			).toMatchObject({
				kind: "edit",
				provenance: "learned",
				source: "attribution:persisted",
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("ignores an attribution file this build cannot read", () => {
		const env = setupTestEnvironment("pi-lens-2430-badfile-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		const dataDir = path.join(env.tmpDir, "data");
		process.env.PILENS_DATA_DIR = dataDir;
		try {
			fs.mkdirSync(dataDir, { recursive: true });
			fs.writeFileSync(
				path.join(dataDir, MUTATION_ATTRIBUTION_FILE),
				JSON.stringify({ version: 99, tools: [{ name: "patch_file" }] }),
			);
			primePersistedMutationAttribution(env.tmpDir);
			expect(lookupLearnedMutatingTool("patch_file")).toBeUndefined();
			// Unreadable is not "learned nothing forever": the tool is still
			// eligible for observation.
			expect(shouldArmObservationForTool("patch_file")).toBe(true);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});
