/**
 * #2442: behavior-preservation for `recentOldTextFailures` in
 * clients/read-guard-tool-lines.ts, migrated from a hand-rolled evict-oldest
 * Map to BoundedFifoMap. `trackOldTextFailure` writes unconditionally (no
 * delete-first refresh, matching the original), so a re-track of an
 * already-resident key does NOT move it, and a read (`_hasOldTextFailureForTests`)
 * must never reorder. No reset seam exists (module-global, process-lifetime
 * tracker) — each test uses a unique key prefix to stay isolated.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_FAILURE_TRACKER_SIZE,
	_hasOldTextFailureForTests,
	_trackOldTextFailureForTests,
} from "../../clients/read-guard-tool-lines.js";

describe("#2442 recentOldTextFailures (FIFO)", () => {
	it("evicts the single oldest (filePath, preview) pair once filled past capacity", () => {
		for (let i = 0; i < MAX_FAILURE_TRACKER_SIZE; i++) {
			_trackOldTextFailureForTests(`/repo/cap-${i}.ts`, "preview");
		}
		expect(_hasOldTextFailureForTests("/repo/cap-0.ts", "preview")).toBe(true);

		_trackOldTextFailureForTests("/repo/cap-overflow.ts", "preview");

		expect(_hasOldTextFailureForTests("/repo/cap-0.ts", "preview")).toBe(false);
		expect(_hasOldTextFailureForTests("/repo/cap-1.ts", "preview")).toBe(true);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_FAILURE_TRACKER_SIZE; i++) {
			_trackOldTextFailureForTests(`/repo/read-${i}.ts`, "preview");
		}
		for (let i = 0; i < 5; i++) {
			_hasOldTextFailureForTests("/repo/read-0.ts", "preview");
		}

		_trackOldTextFailureForTests("/repo/read-overflow.ts", "preview");

		expect(_hasOldTextFailureForTests("/repo/read-0.ts", "preview")).toBe(
			false,
		);
	});

	it("escalates the count for a genuine repeat within the TTL window", () => {
		const first = _trackOldTextFailureForTests("/repo/escalate.ts", "preview");
		const second = _trackOldTextFailureForTests("/repo/escalate.ts", "preview");
		expect(first).toBe(1);
		expect(second).toBe(2);
	});
});
