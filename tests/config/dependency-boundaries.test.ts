import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { parse: parseJson5 } = require("json5") as {
	parse: (source: string) => unknown;
};
const depcruiseBin = resolve(
	repoRoot,
	"node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
);

function cruiseBuiltGraph(): {
	modules: Array<{
		source: string;
		dependencies?: Array<{
			resolved?: string;
			dynamic?: boolean;
		}>;
	}>;
} {
	const output = execFileSync(
		process.execPath,
		[
			depcruiseBin,
			"--validate",
			"--config",
			".dependency-cruiser.cjs",
			"--output-type",
			"json",
			"--no-ignore-known",
			"index.ts",
			"clients/**/*.ts",
		],
		{ cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return JSON.parse(output) as ReturnType<typeof cruiseBuiltGraph>;
}

describe("dependency boundary governance", () => {
	it("keeps the configured boundary rules present", () => {
		const config = require(resolve(repoRoot, ".dependency-cruiser.cjs")) as {
			forbidden: Array<{ name?: string }>;
		};
		const ruleNames = config.forbidden.map((rule) => rule.name).sort();

		expect(ruleNames).toEqual(
			[
				"declared-client-leaf",
				"no-client-cycles",
				"session-start-eager-allowlist-config-dependency-cruiser-eager-allowlist-json",
			].sort(),
		);
	});

	it("keeps the eager allowlist equal to index.ts static client imports", () => {
		const graph = cruiseBuiltGraph();
		const indexModule = graph.modules.find(
			(module) => module.source === "index.ts",
		);
		expect(indexModule).toBeDefined();

		const resolvedStaticImports = (indexModule?.dependencies ?? [])
			.filter(
				(dependency) =>
					dependency.resolved?.startsWith("clients/") && !dependency.dynamic,
			)
			.map((dependency) => `./${dependency.resolved}`)
			.sort();
		const eagerAllowlist = parseJson5(
			readFileSync(
				resolve(repoRoot, "config/dependency-cruiser-eager-allowlist.json"),
				"utf8",
			),
		) as string[];

		expect(eagerAllowlist).toEqual(resolvedStaticImports);
	}, 30_000);

	it("pins the reviewed static-cycle baseline size", () => {
		// Limitation: this count pin does not detect a baseline shrink. A removed
		// entry is invisible when the remaining entries still satisfy the count.
		//
		// #2418: 30 -> 31. The three config loaders now warn through the shared
		// `clients/config-warn.ts` seam, so three entries were RESHAPED (the same
		// pre-existing extension-log -> file-utils -> lens-config cycle, with
		// config-warn on the path instead of each loader directly) and one is
		// net-new: config-warn -> degradation-ledger, the warn seam recording its
		// own ignored-config telemetry. The ledger sits upstream of the config
		// chain, so that edge closes a baseline-class cycle rather than
		// introducing new coupling — the same reasoning entry 30 was accepted
		// under (#2173). Reduction stays tracked in #2125.
		const baseline = parseJson5(
			readFileSync(
				resolve(repoRoot, ".dependency-cruiser-known-violations.json"),
				"utf8",
			),
		) as unknown[];

		expect(baseline).toHaveLength(31);
	}, 30_000);
});
