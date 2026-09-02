/**
 * #2505: every NDJSON log sink shares ONE writer (`clients/ndjson-logger.ts`)
 * so a rotation fix lands once, not as N hand-rolled copies that can drift
 * back out of sync (the single-source-of-truth rule). This is the positive
 * half of that guarantee — every module that LOOKS like an ndjson log sink
 * (the established `*-logger.ts` naming convention, plus the small set of
 * known non-suffix producers) actually delegates to `createNdjsonLogger`
 * rather than defining its own private write/rotate path.
 *
 * The negative half — no `clients/*.ts` file does a raw `fs.appendFile(Sync)`
 * bypassing the shared seam — is already covered by
 * `tests/clients/atomic-write-sweep.test.ts` (`ndjson-logger.ts` is the ONLY
 * reviewed exemption for the append-only-NDJSON shape); this test does not
 * duplicate that scan.
 *
 * The population is DERIVED from disk at test-run time (mechanical, not
 * hand-maintained) so a new `*-logger.ts` module is covered automatically —
 * but a derived population can also go vacuously green if a rename ever
 * drops every file out of the glob (catalog shape 7), so a floor on the
 * derived count guards against that.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { clientSourceFiles, repoRoot } from "../support/atomic-write-scan.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const CREATE_LOGGER_IMPORT =
	/import\s*\{[^}]*\bcreateNdjsonLogger\b[^}]*\}\s*from\s*["']\.\/ndjson-logger\.js["']/;

/** Known ndjson producers that don't match the `*-logger.ts` naming shape. */
const KNOWN_NON_SUFFIX_PRODUCERS = [
	"extension-log.ts",
	"debug-handles.ts",
	"debug-heap.ts",
];

function relativeToClients(absolute: string): string {
	return path
		.relative(path.join(repoRoot, "clients"), absolute)
		.replace(/\\/g, "/");
}

describe("NDJSON writer conformance (#2505)", () => {
	it("every *-logger.ts module (except ndjson-logger.ts itself) delegates to createNdjsonLogger", () => {
		const population = clientSourceFiles()
			.filter((file) => path.basename(file) !== "ndjson-logger.ts")
			.filter((file) => /-logger\.ts$/.test(path.basename(file)));

		// Floor, not an exact count: a derived population that silently drops
		// to zero (e.g. after a mass rename) would make every assertion below
		// vacuously true. Currently 13 files match; keep some margin below
		// that so an unrelated future removal doesn't make this test flaky.
		assertNonEmptyScan("clients/*-logger.ts population", population.length, 10);

		const violations = population
			.map((file) => ({
				file: relativeToClients(file),
				source: fs.readFileSync(file, "utf8"),
			}))
			.filter(({ source }) => !CREATE_LOGGER_IMPORT.test(source))
			.map(({ file }) => file);

		expect(violations).toEqual([]);
	});

	it("known non-suffix ndjson producers also delegate to createNdjsonLogger", () => {
		const clientsRoot = path.join(repoRoot, "clients");
		for (const name of KNOWN_NON_SUFFIX_PRODUCERS) {
			const source = fs.readFileSync(path.join(clientsRoot, name), "utf8");
			expect(
				CREATE_LOGGER_IMPORT.test(source),
				`${name} should import createNdjsonLogger`,
			).toBe(true);
		}
	});
});
