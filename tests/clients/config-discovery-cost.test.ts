/**
 * What a WARM `loadPiLensProjectConfig` costs in filesystem syscalls (#2426
 * review round 5, F-C).
 *
 * Two defects, both introduced by round 4's legacy-document enumeration, both
 * invisible to every behavioural test because neither changes an answer:
 *
 * 1. DOUBLE DISCOVERY. `loadPiLensProjectConfig`'s default argument resolved
 *    the discovery entry, and then `reportLegacyProjectDocuments(startDir)`
 *    resolved the SAME entry again for its records. Every warm load paid the
 *    freshness stats twice, on a path called once per dispatch.
 * 2. AN ANCESTOR-WIDE FRESHNESS KEY. The walk no longer stops at the first
 *    bearing directory, and the entry recorded an mtime for every directory it
 *    visited — up to just below `$HOME`. Churn in any of them (`~/Desktop`,
 *    a temp directory) invalidated the entry and forced a full re-walk,
 *    re-read and re-parse of every legacy document.
 *
 * The probe counts `fs.statSync`. It is the syscall both defects spend, and
 * counting it is the only way either is observable: the config that comes back
 * is identical in every case.
 *
 * `node:fs` is mocked in THIS file alone rather than in a shared config suite,
 * because the counter sees every module in the graph and a shared suite's other
 * cases would move the number for reasons that have nothing to do with
 * discovery.
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ stats: 0, counting: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = (...args: Parameters<typeof actual.statSync>) => {
		if (counter.counting) counter.stats += 1;
		return actual.statSync(...args);
	};
	return { ...actual, default: { ...actual, statSync }, statSync };
});

// After the mock, so the loader under test and this file agree on which
// `statSync` they are talking about.
const fs = await import("node:fs");

const roots: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function write(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Stats spent by ONE call, with the counter armed only for that call. */
function statsFor(run: () => void): number {
	counter.stats = 0;
	counter.counting = true;
	try {
		run();
	} finally {
		counter.counting = false;
	}
	return counter.stats;
}

let previousConfigPath: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousHome = process.env.PI_LENS_HOME;
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	const { resetProjectLensConfigCache } = await import(
		"../../clients/project-lens-config.js"
	);
	resetProjectLensConfigCache();
	const { removeTempDirSync } = await import("./test-utils.js");
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

async function loader() {
	const module = await import("../../clients/project-lens-config.js");
	module.resetProjectLensConfigCache();
	return module;
}

describe("#2426 F-C: a warm project-config load is O(1) in filesystem stats", () => {
	it("spends the same, small stat budget on every one of 500 warm loads", async () => {
		const home = tmpRoot("pi-lens-cost-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-cost-global-");
		process.env.PI_LENS_CONFIG_PATH = path.join(home, "absent", "config.json");
		const projectDir = path.join(home, "proj");
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["dist/**"] });
		write(path.join(projectDir, "pi-lens.json"), { maxProjectFiles: 500 });

		const { loadPiLensProjectConfig } = await loader();
		loadPiLensProjectConfig(projectDir); // cold: populate both caches

		const perLoad: number[] = [];
		for (let index = 0; index < 500; index += 1) {
			perLoad.push(statsFor(() => loadPiLensProjectConfig(projectDir)));
		}
		const distinct = [...new Set(perLoad)];
		// Constant per load — no growth, no second discovery pass. The absolute
		// number is 3 with the fix: the bearing directory's mtime, the legacy
		// document's own (mtime, size) freshness stamp, and the winning file's
		// re-stat. One discovery instead of two.
		expect(
			distinct,
			`stats per warm load (500 loads): ${JSON.stringify(distinct)}`,
		).toEqual([3]);
	});

	it("does not re-walk when an ancestor ABOVE the bearing directory churns", async () => {
		const home = tmpRoot("pi-lens-cost2-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-cost2-global-");
		process.env.PI_LENS_CONFIG_PATH = path.join(home, "absent", "config.json");
		const ancestor = path.join(home, "workspace");
		const projectDir = path.join(ancestor, "pkg");
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["dist/**"] });

		const { loadPiLensProjectConfig } = await loader();
		loadPiLensProjectConfig(projectDir);
		const warm = statsFor(() => loadPiLensProjectConfig(projectDir));

		// Something unrelated writes into an ancestor of the project — a sibling
		// checkout, an editor's scratch file, anything that moves a directory
		// mtime. The freshness key spanned every directory up to just below
		// `$HOME`, so this alone re-walked, re-read and re-parsed.
		fs.writeFileSync(path.join(ancestor, "unrelated.txt"), "churn");
		const churnStamp = new Date(Date.now() + 10_000);
		fs.utimesSync(ancestor, churnStamp, churnStamp);

		const after = statsFor(() => loadPiLensProjectConfig(projectDir));
		expect(after, `warm=${warm} after ancestor churn=${after}`).toBe(warm);
	});

	it("still notices an EDIT to a legacy document above the bearing directory", async () => {
		const home = tmpRoot("pi-lens-cost3-home-");
		process.env.PI_LENS_HOME = tmpRoot("pi-lens-cost3-global-");
		process.env.PI_LENS_CONFIG_PATH = path.join(home, "absent", "config.json");
		const ancestor = path.join(home, "workspace");
		const projectDir = path.join(ancestor, "pkg");
		const legacyAbove = path.join(ancestor, "pi-lens.json");
		write(path.join(projectDir, ".pi-lens.json"), { ignore: ["dist/**"] });
		write(legacyAbove, { ignore: ["above/**"] });

		const { loadPiLensProjectConfig } = await loader();
		loadPiLensProjectConfig(projectDir);
		const warm = statsFor(() => loadPiLensProjectConfig(projectDir));

		// Scoping the DIRECTORY mtimes to the bearing chain does not un-track the
		// legacy documents themselves: each carries its own (mtime, size) stamp,
		// which is what a key set changing under the user's hands moves.
		write(legacyAbove, { ignore: ["above/**"], maxProjectFiles: 700 });
		const editStamp = new Date(Date.now() + 10_000);
		fs.utimesSync(legacyAbove, editStamp, editStamp);

		const after = statsFor(() => loadPiLensProjectConfig(projectDir));
		expect(
			after,
			`warm=${warm} after legacy edit=${after} (a re-walk is expected here)`,
		).toBeGreaterThan(warm);
	});
});
