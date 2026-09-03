/**
 * Regression test for #2525 — `lsp_client_wait_timeout` (and its sibling
 * `lsp_client_wait_skipped`) named PRE-root candidate servers.
 *
 * Root cause: `LSPService.getClientForFile` built its primary wait set as
 * every non-auxiliary server registered for the extension
 * (`getServersForFileWithConfig(...).filter(s => s.role !== "auxiliary")`)
 * and only resolved each server's root INSIDE the sequential trial loop
 * (`ensureClientForServer`). The `lsp_client_wait_timeout`/`_wait_skipped`
 * records still printed that pre-root list (`servers.map(s => s.id)`), so a
 * plain TypeScript project with no `deno.json` read `serverIds:
 * ["typescript","deno"]` even though DenoServer (`fallbackFor: "typescript"`,
 * root gated on `deno.json(c)`) resolved to no root and never had a spawn
 * slot — the #1550 shape recurring (a record naming a subject that did not
 * act), same as #2524.
 *
 * The fix resolves every candidate's root ONCE up front (mirroring the
 * `getClientsForFile`/`getWarmClientForFile` pattern already in this file)
 * and:
 *   - the sequential trial loop and the known-slow shortcut only ever touch
 *     ROOTED candidates (an unrooted fallback is structurally never given a
 *     spawn attempt or a root re-check), and
 *   - the `lsp_client_wait_timeout`/`lsp_client_wait_skipped` records list
 *     only rooted `serverIds`, plus a separate `unrootedCandidates`
 *     `{count, ids}`.
 *
 * This test drives the real `getClientForFile` production path (not a
 * hand-fed input) with a two-server config shaped exactly like
 * typescript+deno: a rooted primary whose spawn is slower than the wait
 * budget (forcing the real `lsp_client_wait_timeout` branch), plus an
 * unrooted `fallbackFor` candidate whose `spawn` throws if ever invoked —
 * proving the loop never attempts it, not just that the record hides it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

function fakeProcess(pid: number) {
	return {
		process: { killed: false },
		stdin: {} as any,
		stdout: {} as any,
		stderr: {} as any,
		pid,
	};
}

describe("getClientForFile wait records — unrooted candidates (#2525)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("lsp_client_wait_timeout names only the rooted candidate, not an unrooted deno-style fallback", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Mirrors the real "typescript" primary: resolves a root and spawns,
		// but cold-start takes longer than the caller's wait budget.
		const typescriptSpawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return fakeProcess(101);
		});
		// Mirrors the real DenoServer: fallbackFor "typescript", root gated on
		// deno.json(c) which does not exist in this project, so root() resolves
		// to undefined. Its spawn must NEVER be invoked — if the wait loop
		// still spent a turn on this unrooted candidate, this throw proves it.
		const denoSpawn = vi.fn(async () => {
			throw new Error("deno must never be attempted without a resolved root");
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "C:/repo",
				spawn: typescriptSpawn,
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				root: async () => undefined,
				spawn: denoSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		// maxWaitMs=1 forces the real timeoutSentinel branch well before the
		// 20ms typescript spawn (or any deno attempt) could settle.
		const result = await service.getClientForFile(file, 1);

		expect(result).toBeUndefined();
		expect(denoSpawn).not.toHaveBeenCalled();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
		};
		expect(metadata.serverIds).toEqual(["typescript"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 1, ids: ["deno"] });
	});

	it("names both candidates when deno.json makes deno a real rooted fallback", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const typescriptSpawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return fakeProcess(102);
		});
		const denoSpawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return fakeProcess(103);
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "C:/repo",
				spawn: typescriptSpawn,
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				// deno.json IS present in this project: a real resolved root.
				root: async () => "C:/repo",
				spawn: denoSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		const result = await service.getClientForFile(file, 1);

		expect(result).toBeUndefined();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
		};
		// Both candidates resolved a root (deno.json present), so both are
		// legitimate wait candidates even though the sequential loop only
		// reached "typescript" before the budget expired.
		expect(metadata.serverIds).toEqual(["typescript", "deno"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 0, ids: [] });
	});
});
