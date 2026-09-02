/**
 * #2442: behavior-preservation for `notifyStallDemotions` in
 * clients/lsp/index.ts, migrated from a hand-rolled evict-oldest Map to
 * BoundedFifoMap. `demoteForNotifyStall` writes unconditionally (no
 * delete-first refresh, matching the original hand-rolled `set()` then
 * `while (size > MAX) evict` shape) — so a re-demotion of an already-tracked
 * key does not move it. There is no read accessor for this map in production
 * (it exists purely to gate a later re-demotion decision at
 * clients/lsp/index.ts:~3237), so eviction is observed via `.get()` through
 * the same private-method harness cast the existing
 * typescript-idle-eviction.test.ts / service-scanner-coverage-gap.test.ts
 * suites already use for `demoteForNotifyStall`.
 *
 * `demoteForNotifyStall`'s only guard is identity: `state.clients.get(key)
 * === entry.client`. Seeding `state.clients` directly with fake client
 * doubles (a `shutdown()` stub) exercises the real eviction path without a
 * real spawn.
 */
import { describe, expect, it } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";

const MAX_NOTIFY_STALL_DEMOTIONS = 50;

function fakeClient() {
	return { shutdown: async () => undefined };
}

interface Harness {
	state: { clients: Map<string, { shutdown: () => Promise<void> }> };
	notifyStallDemotions: Map<string, number>;
	demoteForNotifyStall(
		key: string,
		entry: { client: { shutdown: () => Promise<void> }; info: { id: string } },
		filePath: string,
		reason: unknown,
	): void;
}

function harnessOf(service: LSPService): Harness {
	return service as unknown as Harness;
}

const REASON = { outstandingMs: 1, discriminator: "budget-exceeded" };

describe("#2442 notifyStallDemotions (FIFO)", () => {
	it("evicts the single oldest key once filled past capacity", async () => {
		const service = new LSPService();
		const harness = harnessOf(service);

		for (let i = 0; i < MAX_NOTIFY_STALL_DEMOTIONS; i++) {
			const key = `server-${i}@/repo`;
			const client = fakeClient();
			harness.state.clients.set(key, client);
			harness.demoteForNotifyStall(
				key,
				{ client, info: { id: "fake" } },
				"/repo/main.ts",
				REASON,
			);
		}
		expect(harness.notifyStallDemotions.has("server-0@/repo")).toBe(true);
		expect(harness.notifyStallDemotions.size).toBe(MAX_NOTIFY_STALL_DEMOTIONS);

		const overflowKey = "server-overflow@/repo";
		const overflowClient = fakeClient();
		harness.state.clients.set(overflowKey, overflowClient);
		harness.demoteForNotifyStall(
			overflowKey,
			{ client: overflowClient, info: { id: "fake" } },
			"/repo/main.ts",
			REASON,
		);

		expect(harness.notifyStallDemotions.size).toBe(MAX_NOTIFY_STALL_DEMOTIONS);
		expect(harness.notifyStallDemotions.has("server-0@/repo")).toBe(false);
		expect(harness.notifyStallDemotions.has("server-1@/repo")).toBe(true);
		expect(harness.notifyStallDemotions.has(overflowKey)).toBe(true);

		await service.shutdown();
	});
});
