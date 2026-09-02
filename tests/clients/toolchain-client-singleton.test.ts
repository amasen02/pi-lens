/**
 * #2455 fix round 4, F2 — one GoClient/RustClient per process.
 *
 * `resetGoAvailability`/`resetRustAvailability` clear ONE instance's
 * `createToolchainAvailability` latch. `clients/bootstrap.ts` used to build a
 * SECOND `GoClient`/`RustClient` for `BootstrapClients.goClient`, which is the
 * object `handleSessionStart` reads for its "Active tools" line
 * (`clients/runtime-session.ts`). Two instances, two independent latches: the
 * session reset re-armed the runner's copy while the session-start line kept
 * answering from the bootstrap copy's never-expiring probe-class "missing"
 * verdict, so a go/cargo toolchain installed between sessions stayed invisible
 * for the life of the process — the exact bug the reset was added to fix,
 * still live on the surface a user actually sees.
 *
 * The fix is structural (one instance, exported from the client module both
 * consumers import), so the guard is structural too: an identity assertion on
 * the object bootstrap hands out, plus a ratchet that no other module may
 * construct its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBootstrapClients } from "../../clients/bootstrap.js";
import { createToolchainAvailability } from "../../clients/dispatch/runners/utils/toolchain-availability.js";
import { goClient } from "../../clients/go-client.js";
import { rustClient } from "../../clients/rust-client.js";
import { repoRoot } from "../support/session-state-scan.js";
import {
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const CLIENTS_ROOT = path.join(repoRoot, "clients");

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** `clients/`-relative files constructing `new <Ctor>(`, minus its owner. */
function extraConstructionSites(ctor: string, owner: string): string[] {
	// Both construction spellings this repo uses: the direct `new GoClient()`
	// the runners wrote, and the lazy-import form bootstrap.ts wrote,
	// `new (await import("./go-client.js")).GoClient()`. Matching only the
	// first would have missed the site that caused the bug.
	const pattern = new RegExp(
		String.raw`(?:\bnew\s+|\bnew\s*\(.*?\)\s*\.\s*)${ctor}\s*\(`,
	);
	const sites: string[] = [];
	for (const absolute of listSourceFiles(CLIENTS_ROOT, { skipTests: true })) {
		const relative = relativePosix(CLIENTS_ROOT, absolute);
		if (relative === owner) continue;
		// Stripped so a doc comment naming the constructor is not a call.
		const source = stripSource(fs.readFileSync(absolute, "utf8"), {
			strings: "blank",
		});
		if (pattern.test(source)) sites.push(relative);
	}
	return sites.sort();
}

describe("toolchain clients are process singletons (#2455 fix round 4, F2)", () => {
	it("bootstrap hands out the same GoClient the session reset clears", async () => {
		const clients = await loadBootstrapClients();
		expect(clients.goClient).toBe(goClient);
	});

	it("bootstrap hands out the same RustClient the session reset clears", async () => {
		const clients = await loadBootstrapClients();
		expect(clients.rustClient).toBe(rustClient);
	});

	it("no module builds its own GoClient/RustClient", () => {
		// The ratchet behind the identity assertions above: those two prove the
		// instances agree TODAY, this proves a third consumer cannot quietly mint
		// a fourth latch tomorrow. Each client class owns exactly one instance,
		// in its own module, beside the reset that clears it.
		expect(extraConstructionSites("GoClient", "go-client.ts")).toEqual([]);
		expect(extraConstructionSites("RustClient", "rust-client.ts")).toEqual([]);
	});

	it("proves the hazard: a reset on one instance does not reach another", async () => {
		// Why the two assertions above are worth having. Nothing here is a
		// regression test — it is the mechanism, on the shared seam both clients
		// are built from, using a candidate that appears between the two probes.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tc-twin-"));
		tmpDirs.push(dir);
		const candidatePath = path.join(dir, "toolchain-bin");
		const make = (tool: string) =>
			createToolchainAvailability({
				tool,
				label: tool,
				windowsPaths: [candidatePath],
				unixPaths: [candidatePath],
				probeArgs: ["--version"],
				budgetMs: 3_000,
				log: () => {},
			});
		const first = make("twin-a");
		const second = make("twin-b");

		expect(await first.isAvailable()).toBe(false);
		expect(await second.isAvailable()).toBe(false);

		fs.writeFileSync(candidatePath, "#!/bin/sh\n");
		first.reset();

		expect(await first.isAvailable()).toBe(true);
		// `second` never heard about the reset, so its probe-class "missing"
		// verdict — which `isLatchingOutcome` never expires — still answers.
		expect(await second.isAvailable()).toBe(false);
	});
});
