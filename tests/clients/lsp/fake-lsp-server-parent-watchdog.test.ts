/**
 * #2436 regression: `tests/fixtures/fake-lsp-server.mjs` used to have no
 * lifetime bound of its own — only whatever `afterEach`/kill the spawning
 * test happened to register. A vitest worker fork force-killed under load
 * (or by tinypool's own "Timeout terminating forks worker" escape hatch —
 * see vitest.config.ts) never runs that `afterEach`, so the fixture outlived
 * it: a real orphan was found on disk an hour after its parent process no
 * longer existed, holding its worktree directory open (`git worktree
 * remove` → Permission denied / Device or resource busy).
 *
 * This spawns the fixture via a parent SHIM
 * (`fake-lsp-server-parent-shim.mjs`) that mimics the worst teardown shape
 * the evidence points at: piped stdio, `detached: true` — no OS
 * job/process-group auto-reap at all (the exact shape `launchLSP` uses on
 * POSIX, and the shape a failed Windows job-nesting assignment degrades
 * to) — driving the fixture through `FAKE_LSP_WEDGE_STDIN_AFTER_INIT`, which
 * installs a real non-`unref`'d `setInterval` (the same shape
 * service-notify-cpu-liveness.test.ts and shutdown-live-wedged-process.test.ts
 * spawn). That mode is load-bearing for this being a genuine repro: an idle
 * fake-lsp-server has no other active handle, so it already exits on its
 * own the moment Node's event loop empties after stdin closes — proving
 * nothing about the watchdog. The wedge interval means only an explicit
 * `process.exit()` can end it. It then SIGKILLs the shim outright — no
 * graceful shutdown, no `afterEach`, nothing JS-level — and asserts the
 * fixture exits within 2s on its own, via the parent-liveness watchdog this
 * fix adds.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "../../fixtures");
const FAKE_SERVER_PATH = path.join(FIXTURE_DIR, "fake-lsp-server.mjs");
const SHIM_PATH = path.join(FIXTURE_DIR, "fake-lsp-server-parent-shim.mjs");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	stepMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return predicate();
}

describe("fake-lsp-server.mjs — parent-death watchdog (#2436)", () => {
	let shim: ChildProcess | undefined;
	let serverPid: number | undefined;

	afterEach(() => {
		if (shim && shim.exitCode === null && shim.signalCode === null) {
			shim.kill("SIGKILL");
		}
		if (serverPid !== undefined && isAlive(serverPid)) {
			try {
				process.kill(serverPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		shim = undefined;
		serverPid = undefined;
	});

	it("exits within 2s of its parent being SIGKILLed, with no graceful shutdown", async () => {
		shim = spawn(process.execPath, [SHIM_PATH, FAKE_SERVER_PATH], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FAKE_LSP_WEDGE_STDIN_AFTER_INIT: "1" },
		});

		let out = "";
		shim.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});

		const gotPid = await waitUntil(
			() => /CHILD_PID:(\d+)/.test(out),
			5_000,
			20,
		);
		expect(gotPid).toBe(true);
		const match = /CHILD_PID:(\d+)/.exec(out);
		expect(match).not.toBeNull();
		serverPid = Number(match?.[1]);
		expect(isAlive(serverPid)).toBe(true);

		// Give the handshake (initialize -> initialized, sent by the shim) time
		// to actually reach the fixture and arm FAKE_LSP_WEDGE_STDIN_AFTER_INIT's
		// non-unref'd interval — the load-bearing part of this repro.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(isAlive(serverPid)).toBe(true);

		// No graceful shutdown, no exit notification, no afterEach on the
		// shim's side — kill the parent outright, exactly like a force-killed
		// vitest worker fork.
		shim.kill("SIGKILL");

		const died = await waitUntil(
			() => !isAlive(serverPid as number),
			2_000,
			50,
		);
		expect(died).toBe(true);
	}, 10_000);
});
