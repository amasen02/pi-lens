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
 * The fix resolves roots where the RECORDS are emitted — the known-slow and
 * wait-timeout branches, plus the `lsp_client_unavailable` bookkeeping — all
 * of them cold paths, memoized so one acquisition asks a given server at most
 * once. The `lsp_client_wait_timeout`/`lsp_client_wait_skipped` records then
 * list only rooted `serverIds`, plus a separate `unrootedCandidates`
 * `{count, ids}`.
 *
 * Roots are explicitly NOT hoisted to the top of `getClientForFile`: the
 * sequential trial loop needs none of its own (`ensureClientForServer`
 * resolves and bails at `!root` before any spawn work), and `NearestRoot`
 * caches only successful hits, so hoisting charges a full walk to the
 * filesystem root for every unrooted fallback on every touch of every file —
 * including the warm-hit path, which emits no record at all. The
 * root-invocation-count cases below are the guard on that cost.
 *
 * These tests drive the real `getClientForFile` production path (not a
 * hand-fed input) with a two-server config shaped exactly like
 * typescript+deno.
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
		// to undefined. A throwing spawn keeps the double faithful — an unrooted
		// server has no binary to launch — but the assertion that matters is on
		// the record below; "spawn was not called" holds on the pre-fix code too
		// (`ensureClientForServer` has always bailed at `!root`), so asserting it
		// would be vacuous.
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

	it("resolves no root for an unrooted fallback on the warm-hit path (hot-path cost guard)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Root-invocation counters ARE the assertion here. `NearestRoot` caches
		// only SUCCESSFUL hits (clients/lsp/server.ts — negatives are
		// deliberately uncached so a scaffolded deno.json is picked up without a
		// restart), so every call on an unrooted candidate is a fresh stat-walk
		// to the filesystem root. A served warm touch must therefore never ask
		// an unrooted fallback for its root at all: `getClientForFile` returns
		// as soon as the primary serves, long before any wait record is emitted.
		const typescriptRoot = vi.fn(async () => "C:/repo");
		const denoRoot = vi.fn(async () => undefined);

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: typescriptRoot,
				spawn: vi.fn(async () => fakeProcess(201)),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				root: denoRoot,
				spawn: vi.fn(async () => fakeProcess(202)),
			},
		]);

		const file = "C:/repo/main.ts";
		// Touch 1 spawns (cold); touches 2 and 3 hit the published client (warm).
		for (let i = 0; i < 3; i++) {
			expect(await service.getClientForFile(file)).toBeTruthy();
		}

		// The unrooted deno-style fallback is never consulted on a path that was
		// served: no wait record is emitted, so its root is never needed.
		expect(denoRoot).toHaveBeenCalledTimes(0);
		// And the served primary resolves at most once per touch.
		expect(typescriptRoot.mock.calls.length).toBeLessThanOrEqual(3);
	});

	it("lsp_client_wait_skipped names only rooted candidates on the known-slow shortcut", async () => {
		vi.useFakeTimers();
		const { recordSuccessfulLspSpawn } =
			await import("../../../clients/lsp/spawn-history.js");
		// Spawn history says typescript takes 6s; with a 750ms budget the
		// known-slow shortcut fires the moment the spawn is noted in flight.
		recordSuccessfulLspSpawn("typescript", 6_000);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const suspended = new Promise<never>(() => {});
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => "C:/repo",
				spawn: vi.fn(async () => {
					await suspended;
					return fakeProcess(301);
				}),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				root: async () => undefined,
				spawn: vi.fn(async () => fakeProcess(302)),
			},
		]);

		const result = await service.getClientForFile("C:/repo/main.ts", 750);
		expect(result).toBeUndefined();

		const skippedCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_skipped",
		);
		expect(skippedCalls).toHaveLength(1);
		const metadata = skippedCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
			reason: string;
		};
		expect(metadata.reason).toBe("budget_skipped_known_slow");
		expect(metadata.serverIds).toEqual(["typescript"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 1, ids: ["deno"] });
	});

	it("resolves each candidate's root at most once on an unserved touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Neither candidate resolves a root, so nothing is served and the
		// `lsp_client_unavailable` bookkeeping runs. That bookkeeping must not
		// re-walk a root the acquisition attempt already resolved: on a
		// no-root project every extra call is a full walk to the filesystem
		// root (negatives are uncached).
		const typescriptRoot = vi.fn(async () => undefined);
		const denoRoot = vi.fn(async () => undefined);

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: typescriptRoot,
				spawn: vi.fn(async () => fakeProcess(401)),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				root: denoRoot,
				spawn: vi.fn(async () => fakeProcess(402)),
			},
		]);

		expect(await service.getClientForFile("C:/repo/main.ts")).toBeUndefined();

		expect(typescriptRoot).toHaveBeenCalledTimes(1);
		expect(denoRoot).toHaveBeenCalledTimes(1);
	});
});
