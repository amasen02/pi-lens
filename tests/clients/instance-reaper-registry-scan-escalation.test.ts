/**
 * #2527 review F2: `sweepOrphans` (the REGISTRY-DRIVEN reaper) has two scanner
 * queries of its own — `queryCommandLines` (identity verification before any
 * pid kill) and `findPidsByMarkerWindows` (the marker command-line fallback
 * search) — that omitted `onTimeout` entirely when they were added. A query
 * that blows `BACKSTOP_SCAN_TIMEOUT_MS` therefore fell through to
 * `child-unref.ts`'s DEFAULT handler: one bare, unverified `child.kill()`, no
 * tree kill, no identity-carrying ledger record — the exact scanner
 * abandonment `terminateScannerChild`'s own doc comment says it exists to
 * prevent, reachable from INSIDE the orphan backstop's own registry-driven
 * path. `enumerateManagedProcesses` (the OTHER backstop scanner, exercised by
 * `sweepUntrackedOrphans` in instance-reaper-backstop.test.ts) already wired
 * `onTimeout`; these two call sites had not.
 *
 * This drives the REAL production path — `sweepOrphans()` (clients/
 * instance-reaper.js) through a REAL `BACKSTOP_SCAN_TIMEOUT_MS` timeout into
 * the REAL, unmocked `terminateScannerChild` and its real tree-kill-and-
 * verify machinery — never a hand-fed call to `terminateScannerChild` or
 * `queryProcessTable` themselves. Only `node:child_process`'s `spawn` and
 * `process.kill` are mocked (same technique as
 * instance-reaper-backstop.test.ts), so no real OS process is ever touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnRecord {
	command: string;
	args: string[];
}

const h = vi.hoisted(() => {
	const spawns: SpawnRecord[] = [];
	const state: {
		registry: unknown[];
		enabled: boolean;
		/** pids the fake `process.kill(pid, 0)` probe reports as alive. */
		alivePids: Set<number>;
		/** how many non-`taskkill` ("scanner") children have been spawned so far. */
		scannerSpawnCount: number;
		/** 1-based scanner-spawn index that should hang forever (exercises the
		 *  caller's own timeout); 0 disables hanging entirely. */
		hangOnScannerIndex: number;
		/** pids of every scanner child spawned, in spawn order. */
		scannerPids: number[];
	} = {
		registry: [],
		enabled: true,
		alivePids: new Set<number>(),
		scannerSpawnCount: 0,
		hangOnScannerIndex: 0,
		scannerPids: [],
	};
	let nextPid = 80_000;
	function makeFakeChild(command: string, _args: string[]) {
		const isKill = command.toLowerCase().includes("taskkill");
		const pid = nextPid++;
		let scannerIndex = 0;
		if (!isKill) {
			state.scannerSpawnCount++;
			scannerIndex = state.scannerSpawnCount;
			state.scannerPids.push(pid);
		}
		const hang = !isKill && scannerIndex === state.hangOnScannerIndex;
		const stdoutHandlers: Array<(chunk: string) => void> = [];
		const child = {
			pid,
			stdout: {
				on(event: string, cb: (chunk: string) => void) {
					if (event === "data") stdoutHandlers.push(cb);
				},
				unref() {},
			},
			stderr: null,
			stdin: null,
			unref() {},
			kill() {},
			once(event: string, cb: (...a: unknown[]) => void) {
				if (hang) return child; // never settles — exercises the caller's timeout
				if (event === "close") {
					queueMicrotask(() => cb(0, null));
				}
				return child;
			},
		};
		return child;
	}
	return { spawns, state, makeFakeChild };
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) => {
		h.spawns.push({ command, args });
		return h.makeFakeChild(command, args);
	}),
}));

vi.mock("../../clients/instance-registry.js", () => ({
	isInstanceRegistryEnabled: () => h.state.enabled,
	readInstanceRegistry: async () => h.state.registry,
}));

import {
	BACKSTOP_SCAN_TIMEOUT_MS,
	sweepOrphans,
} from "../../clients/instance-reaper.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

function reasonsFor(kind: string): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find((g) => g.kind === kind)?.latestReasons ?? []
	);
}

function deadParentInstanceWithChild(child: {
	pid: number;
	marker?: string;
}): unknown {
	return {
		pid: 1, // dead parent — never in alivePids below
		startedAt: new Date().toISOString(),
		projectRoot: "/proj",
		lspChildren: [
			{
				pid: child.pid,
				serverId: "ast-grep",
				command: "ast-grep.exe",
				spawnedAt: new Date().toISOString(),
				marker: child.marker,
			},
		],
		lspChildCount: 1,
		rssBytes: 0,
		heartbeatAt: new Date().toISOString(),
	};
}

beforeEach(() => {
	h.spawns.length = 0;
	h.state.registry = [];
	h.state.enabled = true;
	h.state.alivePids = new Set<number>();
	h.state.scannerSpawnCount = 0;
	h.state.hangOnScannerIndex = 0;
	h.state.scannerPids.length = 0;
	resetDegradationLedger();
	vi.useFakeTimers();
	vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
		if (h.state.alivePids.has(Math.abs(pid))) return true;
		const err = new Error("no such process") as NodeJS.ErrnoException;
		err.code = "ESRCH";
		throw err;
	}) as unknown as typeof process.kill);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("#2527 review F2: sweepOrphans' own scanner queries escalate through terminateScannerChild", () => {
	it("queryCommandLines' timed-out scanner is tree-killed and recorded under the backstop kind, not abandoned unverified", async () => {
		// Dead parent, dead child, no marker: queryCommandLines(candidatePids)
		// still runs (it is unconditional, ahead of the dead/alive decision) and
		// is this test's only scanner query.
		h.state.registry = [
			deadParentInstanceWithChild({ pid: 100 }),
		];
		h.state.hangOnScannerIndex = 1; // the queryCommandLines spawn

		const sweep = sweepOrphans();
		await vi.advanceTimersByTimeAsync(BACKSTOP_SCAN_TIMEOUT_MS + 1_000);
		await sweep;

		// Pre-fix: `onTimeout` was omitted, so no `terminateScannerChild` call
		// ever fires, and this record never appears — the scanner is abandoned
		// with a single bare, unverified `child.kill()` instead.
		const reasons = reasonsFor("orphan-backstop-scanner-escalated");
		expect(reasons).toHaveLength(1);
		expect(reasons[0].reason).toContain(`${BACKSTOP_SCAN_TIMEOUT_MS}ms`);
		// The escalation's subject is the scanner child that was killed, not the
		// LSP child pid (100) the query was trying to identify.
		expect(reasons[0].subject).toContain(String(h.state.scannerPids[0]));
		expect(reasons[0].subject).not.toContain("#100");
	});

	it("findPidsByMarkerWindows' timed-out scanner is tree-killed and recorded under the backstop kind, not abandoned unverified", async () => {
		// Dead parent, dead child, WITH a marker: queryCommandLines resolves
		// cleanly (index 1, not hung), then decideOrphanReaping routes the dead
		// child into markerSearches, and findPidsByMarkerWindows (scanner index
		// 2) is the one that hangs.
		h.state.registry = [
			deadParentInstanceWithChild({
				pid: 100,
				marker: "C:/temp/pi-lens-ast-grep/x.yml",
			}),
		];
		h.state.hangOnScannerIndex = 2; // the findPidsByMarkerWindows spawn

		const sweep = sweepOrphans();
		await vi.advanceTimersByTimeAsync(BACKSTOP_SCAN_TIMEOUT_MS + 1_000);
		await sweep;

		expect(h.state.scannerPids).toHaveLength(2);
		const reasons = reasonsFor("orphan-backstop-scanner-escalated");
		expect(reasons).toHaveLength(1);
		expect(reasons[0].reason).toContain(`${BACKSTOP_SCAN_TIMEOUT_MS}ms`);
		expect(reasons[0].subject).toContain(String(h.state.scannerPids[1]));
	});
});
