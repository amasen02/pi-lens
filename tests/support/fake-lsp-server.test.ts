/**
 * #2436 review-round fidelity proof: `spawnFakeLspServer`'s `onTestFinished`
 * backstop kill (tests/support/fake-lsp-server.ts) had zero test pinning it —
 * every consuming test happens to call its own kill/cleanup, so a refactor
 * that silently dropped the registration would go unnoticed until the exact
 * shape #2436 found: a test whose own cleanup never runs, leaking the
 * fixture. This pins the backstop directly: test A spawns via the helper and
 * deliberately never kills the process; test B (which runs after test A
 * finishes, since vitest runs `it` blocks in a `describe` sequentially by
 * default) asserts test A's child is already dead — proof the
 * `onTestFinished` hook, not some incidental cleanup, did the killing.
 *
 * Deliberately no `afterEach` here: an `afterEach` registered in this file
 * would race the very backstop under test (both would fire once test A
 * finishes) and could mask a broken backstop by killing the leaked process
 * before test B gets to look at it. The only cleanup is an `afterAll`, which
 * runs strictly after test B's assertion has already been made.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnFakeLspServer } from "./fake-lsp-server.js";

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

describe("spawnFakeLspServer — onTestFinished backstop (#2436)", () => {
	let leakedPid: number | undefined;

	afterAll(() => {
		// Sweep only if the backstop under test actually failed (mutation
		// runs, or a genuine regression) — the passing case has already
		// reaped this before we get here, making this a no-op.
		if (leakedPid !== undefined && isAlive(leakedPid)) {
			try {
				process.kill(leakedPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});

	it("spawns the fixture and deliberately does not kill it", async () => {
		const proc = await spawnFakeLspServer();
		const pid = proc.process.pid;
		expect(pid).toBeDefined();
		expect(isAlive(pid as number)).toBe(true);
		leakedPid = pid;
		// No kill() here on purpose — the onTestFinished backstop registered
		// inside spawnFakeLspServer is the only thing that should reap this.
	});

	it("the backstop reaped the previous test's process once it finished", async () => {
		expect(leakedPid).toBeDefined();
		const died = await waitUntil(
			() => !isAlive(leakedPid as number),
			2_000,
			50,
		);
		expect(died).toBe(true);
	});
});
