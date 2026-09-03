import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	type LspMutationContext,
	recordLspMutation,
} from "../../clients/lsp-mutation.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * #2460 substitution-style mutation proof: `bookkeepLspMutation`'s per-batch
 * autofix dedupe used to hand-roll its eviction over a bare `Set<string>`
 * (`context.autofixRecordedPaths`), capped at `MAX_SAMPLES` (100). It now
 * goes through `BoundedSet` (`clients/bounded-cache.ts`). This drives the
 * cap through the real `recordLspMutation` seam — never a hand-fed
 * `BoundedSet` — so a regression in the migration (wrong cap, LRU instead of
 * FIFO, a reordering read) shows up here even though `bounded-cache.test.ts`
 * covers the primitive itself in isolation.
 */
function record(context: LspMutationContext, filePath: string): void {
	recordLspMutation(context, {
		bookkeep: true,
		results: [
			{
				descriptions: [],
				files: [filePath],
				operationTotal: 1,
				appliedOperationTotal: 1,
				appliedOperationIndexes: [0],
				operationCounts: {
					textEdits: 1,
					create: 0,
					rename: 0,
					delete: 0,
				},
				fileDetails: [
					{ filePath, range: { start: 1, end: 2 }, importsChanged: false },
				],
			},
		],
	});
}

describe("lsp-mutation autofix dedupe cap (#2460)", () => {
	it("dedupes within the cap and re-fires for a path evicted FIFO past it", () => {
		const env = setupTestEnvironment("pi-lens-2460-autofix-cap-");
		try {
			const recorded: string[] = [];
			const context: LspMutationContext = {
				cwd: env.tmpDir,
				correlationId: "autofix-cap-1",
				tool: "workspace/applyEdit",
				source: "autofix",
				emitSummary: false,
				recordAutofix: (filePath) => recorded.push(filePath),
			};

			const first = path.join(env.tmpDir, "first.ts");
			fs.writeFileSync(first, "export const x = 1;\n");

			// First mutation: recorded once.
			record(context, first);
			expect(recorded).toHaveLength(1);

			// A second mutation to the SAME path within the cap is deduped — the
			// per-batch autofix publisher fires once per path, not once per write.
			record(context, first);
			expect(recorded).toHaveLength(1);

			// Push 100 (MAX_SAMPLES) distinct NEW paths through. FIFO order makes
			// `first` (inserted before all of them) the one the cap evicts.
			for (let index = 0; index < 100; index += 1) {
				const filler = path.join(env.tmpDir, `filler-${index}.ts`);
				fs.writeFileSync(filler, "export const y = 1;\n");
				record(context, filler);
			}
			expect(recorded).toHaveLength(101); // first + 100 fillers, all new

			// `first` was evicted by the cap, so mutating it again is a genuinely
			// new observation from the dedupe set's point of view and re-fires.
			record(context, first);
			expect(recorded).toHaveLength(102);
			expect(recorded[0]).toBe(first);
			expect(recorded[101]).toBe(first);
		} finally {
			env.cleanup();
		}
	});
});
