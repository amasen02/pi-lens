import { describe, expect, it } from "vitest";
import {
	resolveArrayDeny,
	resolveBooleanDeny,
} from "../../../clients/config-core/deny.js";
import {
	type ConfigSource,
	merge,
} from "../../../clients/config-core/merge.js";
import { SOURCE_TIERS } from "../../../clients/config-core/provenance.js";
import type { ConfigValue } from "../../../clients/config-core/schema.js";
import { DENY_ONLY_SCHEMA } from "../../support/config-core-fixtures.js";

/** The whole resolution as one comparable string, provenance included. */
function fingerprint(sources: readonly ConfigSource[]): string {
	const resolved = merge(sources, DENY_ONLY_SCHEMA);
	return JSON.stringify({
		value: resolved.value,
		provenance: [...resolved.provenance.entries()].sort(),
	});
}

const OPERATOR_DENY: ConfigSource = {
	tier: "global",
	file: "~/.pi-lens/config.json",
	value: { enabled: false, blocked: ["gopls"] },
};

/**
 * #2415 AC 3. Every field a repository could write to weaken the operator's
 * denial, tried one at a time and together. The bar is BYTE-IDENTICAL: not
 * "still disabled", but the same resolved document and the same provenance, so
 * a partial weakening that merely looked denied would still fail.
 */
const WEAKENING_MUTATIONS: ReadonlyArray<{
	readonly name: string;
	readonly value: ConfigValue;
	readonly tier: "project" | "nested-project";
}> = [
	{
		name: "project sets enabled true",
		value: { enabled: true },
		tier: "project",
	},
	{
		name: "project empties the deny list",
		value: { blocked: [] },
		tier: "project",
	},
	{
		name: "project does both at once",
		value: { enabled: true, blocked: [] },
		tier: "project",
	},
	{
		name: "nested project sets enabled true",
		value: { enabled: true },
		tier: "nested-project",
	},
	{
		name: "nested project empties the deny list",
		value: { blocked: [] },
		tier: "nested-project",
	},
	{
		name: "nested project does both at once",
		value: { enabled: true, blocked: [] },
		tier: "nested-project",
	},
];

describe("monotonic deny: repo config cannot weaken an operator denial (#2425)", () => {
	const baseline = fingerprint([OPERATOR_DENY]);

	it("resolves the operator denial in the first place", () => {
		expect(JSON.parse(baseline).value).toEqual({
			enabled: false,
			blocked: ["gopls"],
		});
	});

	it("covers every tier the mutation matrix claims to", () => {
		// Declared floor: an emptied matrix must FAIL, not read as clean.
		expect(WEAKENING_MUTATIONS.length).toBeGreaterThanOrEqual(6);
		expect(new Set(WEAKENING_MUTATIONS.map((m) => m.tier))).toEqual(
			new Set(["project", "nested-project"]),
		);
	});

	for (const mutation of WEAKENING_MUTATIONS) {
		it(`is byte-identical when the ${mutation.name}`, () => {
			const mutated = fingerprint([
				OPERATOR_DENY,
				{
					tier: mutation.tier,
					file: ".pi-lens.json",
					trust: "trusted",
					value: mutation.value,
				},
			]);
			expect(mutated).toBe(baseline);
		});
	}

	it("lets a repo tier ADD a denial while still not removing one", () => {
		// Monotonic means one-directional, not frozen: a project may deny more.
		const resolved = merge(
			[
				OPERATOR_DENY,
				{ tier: "project", value: { blocked: ["rust-analyzer"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({
			enabled: false,
			blocked: ["gopls", "rust-analyzer"],
		});
	});

	it("keeps the denial even when the repo config is TRUSTED", () => {
		// Trust decides whether a repo command may SPAWN. It never decides
		// whether a repo file may re-enable what the operator switched off.
		const trusted = fingerprint([
			OPERATOR_DENY,
			{
				tier: "project",
				file: ".pi-lens.json",
				trust: "trusted",
				value: { enabled: true, blocked: [] },
			},
		]);
		expect(trusted).toBe(baseline);
	});

	it("attributes the denial to the tier that made it, not the last tier to see it", () => {
		const resolved = merge(
			[
				OPERATOR_DENY,
				{ tier: "project", value: { enabled: true } },
				{ tier: "nested-project", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.provenance.get("/enabled")).toEqual({
			tier: "global",
			key: "/enabled",
			file: "~/.pi-lens/config.json",
		});
	});
});

describe("monotonic deny: the one legitimate lift (#2425)", () => {
	it("lets an operator tier ABOVE a repo denial re-enable it", () => {
		const resolved = merge(
			[
				{ tier: "project", value: { enabled: false } },
				{ tier: "cli", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: true });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("cli");
	});

	it("does NOT let another repo tier re-enable a repo denial", () => {
		const resolved = merge(
			[
				{ tier: "project", value: { enabled: false } },
				{ tier: "nested-project", value: { enabled: true } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("project");
	});

	it("does NOT let an operator tier BELOW a repo denial re-enable it", () => {
		// A built-in default saying `true` is the absence of an opinion, not an
		// operator overriding a repository.
		const resolved = merge(
			[
				{ tier: "builtin", value: { enabled: true } },
				{ tier: "project", value: { enabled: false } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ enabled: false });
		expect(resolved.provenance.get("/enabled")?.tier).toBe("project");
	});

	it("never lets any tier lift an OPERATOR denial", () => {
		for (const tier of SOURCE_TIERS) {
			const resolved = merge(
				[
					{ tier: "global", value: { enabled: false } },
					{ tier, value: { enabled: true } },
				],
				DENY_ONLY_SCHEMA,
			);
			expect(resolved.value, tier).toEqual({ enabled: false });
		}
	});
});

describe("array-union denials accumulate and never shrink (#2425)", () => {
	it("unions members across tiers, lowest precedence first", () => {
		const resolved = merge(
			[
				{ tier: "builtin", value: { blocked: ["a"] } },
				{ tier: "global", value: { blocked: ["b", "a"] } },
				{ tier: "project", value: { blocked: ["c"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ blocked: ["a", "b", "c"] });
		expect(resolved.provenance.get("/blocked")?.tier).toBe("builtin");
	});

	it("beats the node's own replace strategy, which would have erased a member", () => {
		// `blocked` declares no strategy, so it defaults to `replace`. The deny
		// annotation is what stops the nearer tier's shorter list from winning.
		const resolved = merge(
			[
				{ tier: "global", value: { blocked: ["gopls"] } },
				{ tier: "project", value: { blocked: ["rust-analyzer"] } },
			],
			DENY_ONLY_SCHEMA,
		);
		expect(resolved.value).toEqual({ blocked: ["gopls", "rust-analyzer"] });
	});
});

describe("deny resolvers in isolation (#2425)", () => {
	it("falls through to last-wins when nothing denies", () => {
		expect(
			resolveBooleanDeny([
				{ tier: "global", value: true },
				{ tier: "project", value: true },
			]),
		).toEqual({ value: true, winner: 1, denied: false });
	});

	it("reports no winner for an empty contribution list", () => {
		expect(resolveBooleanDeny([])).toEqual({
			value: undefined,
			winner: -1,
			denied: false,
		});
	});

	it("ignores non-array contributions to a union list", () => {
		expect(
			resolveArrayDeny([
				{ tier: "global", value: "not-a-list" },
				{ tier: "project", value: ["x"] },
			]),
		).toEqual({ value: ["x"], winner: 1, denied: true });
	});

	it("keeps structurally equal object members rather than folding them", () => {
		const resolution = resolveArrayDeny([
			{ tier: "global", value: [{ id: "x" }] },
			{ tier: "project", value: [{ id: "x" }] },
		]);
		expect(resolution.value).toEqual([{ id: "x" }, { id: "x" }]);
	});
});
