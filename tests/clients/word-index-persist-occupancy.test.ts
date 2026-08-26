import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
} from "../../clients/word-index.js";
import { measureMaxSyncBlockMs } from "../support/perf-harness.js";

describe("incremental word-index persist occupancy (#2068)", () => {
	it(
		"measures dirty-fraction scaling on the review fixture",
		{ timeout: 120_000 },
		() => {
			const shared = Array.from({ length: 200 }, (_, i) => `shared_${i}`).join(
				" ",
			);
			const docs = Array.from({ length: 750 }, (_, file) => ({
				path: `src/f${file}.ts`,
				content: `${shared} stable_${file}`,
			}));
			const fullIndex = buildWordIndex(docs);
			const fullStarted = performance.now();
			serializeWordIndex(fullIndex);
			const fullMs = performance.now() - fullStarted;
			const measurements: Array<{ dirty: number; ms: number }> = [];
			for (const dirty of [1, 75, 750]) {
				const index = buildWordIndex(docs);
				serializeWordIndex(index);
				for (let file = 0; file < dirty; file += 1) {
					updateWordIndexDocument(index, {
						path: `src/f${file}.ts`,
						content: `${shared} changed_${file}`,
					});
				}
				const started = performance.now();
				serializeWordIndex(index);
				measurements.push({ dirty, ms: performance.now() - started });
			}
			console.log(
				JSON.stringify({
					fixture: "750-doc/200-shared-token",
					fullMs,
					measurements,
				}),
			);
			expect(measurements).toHaveLength(3);
			expect(measurements[0].ms).toBeLessThan(fullMs);
			expect(measurements[1].ms).toBeLessThan(fullMs);
			expect(measurements[2].ms).toBeLessThan(fullMs * 1.5);
		},
	);

	it(
		"keeps a one-document persist below the hot-path budget at 2M postings",
		{ retry: 2, timeout: 120_000 },
		async () => {
			// 999 documents provide nearly 2M postings for 2,000 shared tokens.
			// The edited document has low-degree tokens, so the fixed path must not
			// scan the high-degree lists belonging to untouched documents.
			const shared = Array.from(
				{ length: 2_000 },
				(_, line) => `shared_${line}`,
			).join("\n");
			const docs = [
				...Array.from({ length: 999 }, (_, file) => ({
					path: `src/f${file}.ts`,
					content: shared,
				})),
				{
					path: "src/target.ts",
					content: "target_token",
				},
			];
			const index = buildWordIndex(docs);
			serializeWordIndex(index);
			updateWordIndexDocument(index, {
				path: docs[docs.length - 1].path,
				content: "changed_token",
			});

			const maxBlockMs = await measureMaxSyncBlockMs(async () => {
				serializeWordIndex(index);
			});
			// Issue #2068 measured 1,183ms before this change on 2,221,462 postings.
			// This branch measures the fixed flat incremental path at about 10ms.
			expect(maxBlockMs).toBeLessThan(50);
		},
	);
});
