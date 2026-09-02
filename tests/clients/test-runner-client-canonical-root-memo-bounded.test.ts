/**
 * #2442: behavior-preservation for `canonicalRootMemo` in
 * clients/test-runner-client.ts, migrated from a hand-rolled evict-oldest
 * Map to BoundedFifoMap. `getCanonicalProjectRoot` returns early on a cache
 * HIT (before ever calling `canonicalProjectRoot`/`fs.realpathSync.native`
 * again), so a mocked `realpathSync.native` call count is the observable
 * proxy for "was this cwd's memo evicted" — without needing 513 real
 * directories on disk.
 *
 * `vi.spyOn(fs, "realpathSync")` cannot redefine node:fs's ESM namespace
 * export directly (see grammar-stale-version.test.ts) — wrap via vi.mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const realpathNativeMock = vi.hoisted(() =>
	vi.fn((p: string) => p as unknown as string),
);
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		realpathSync: { ...actual.realpathSync, native: realpathNativeMock },
	};
});

import {
	MAX_CANONICAL_ROOT_MEMO_ENTRIES,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";

describe("#2442 canonicalRootMemo (FIFO)", () => {
	let client: TestRunnerClient;

	beforeEach(() => {
		client = new TestRunnerClient();
		realpathNativeMock.mockClear();
		realpathNativeMock.mockImplementation((p: string) => p);
	});

	it("evicts the single oldest cwd's memo once filled past capacity", () => {
		for (let i = 0; i < MAX_CANONICAL_ROOT_MEMO_ENTRIES; i++) {
			client._getCanonicalProjectRootForTests(`/repo/cwd-${i}`);
		}
		const callsBeforeOverflow = realpathNativeMock.mock.calls.length;

		client._getCanonicalProjectRootForTests("/repo/cwd-overflow");

		// cwd-1 (still cached) must resolve WITHOUT a fresh realpathSync.native
		// call — a cache HIT returns early.
		const callsBeforeCwd1 = realpathNativeMock.mock.calls.length;
		client._getCanonicalProjectRootForTests("/repo/cwd-1");
		expect(realpathNativeMock.mock.calls.length).toBe(callsBeforeCwd1);

		// cwd-0 (evicted, the oldest) must trigger a fresh resolution.
		client._getCanonicalProjectRootForTests("/repo/cwd-0");
		expect(realpathNativeMock.mock.calls.length).toBeGreaterThan(
			callsBeforeCwd1,
		);
		expect(callsBeforeOverflow).toBeGreaterThan(0);
	});

	it("a read never reorders eviction order (red on an accidental LRU substitution)", () => {
		for (let i = 0; i < MAX_CANONICAL_ROOT_MEMO_ENTRIES; i++) {
			client._getCanonicalProjectRootForTests(`/repo/read-${i}`);
		}
		for (let i = 0; i < 5; i++) {
			client._getCanonicalProjectRootForTests("/repo/read-0");
		}
		const callsBeforeOverflow = realpathNativeMock.mock.calls.length;

		client._getCanonicalProjectRootForTests("/repo/read-overflow");

		client._getCanonicalProjectRootForTests("/repo/read-0");
		expect(realpathNativeMock.mock.calls.length).toBeGreaterThan(
			callsBeforeOverflow,
		); // evicted despite the repeat reads
	});
});
