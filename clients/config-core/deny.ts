/**
 * Monotonic deny precedence (#2425, scope item 4; #2415 AC 3).
 *
 * Ordinary config values are last-tier-wins. Denials are not. A denial is a
 * SECURITY decision, and the tier that made it is usually the tier the user
 * actually controls, so the ordinary rule is exactly backwards for it: today a
 * repository can hand pi-lens a `.pi-lens.json` that re-enables a server the
 * user disabled globally, and nothing notices.
 *
 * The rule, in one sentence: a denial from an OPERATOR tier is never lifted,
 * and a denial from a REPO tier is lifted only by an explicit operator allow.
 * `provenance.ts` owns the operator/repo split; this module owns what it means.
 *
 * The two shapes a denial takes (`schema.ts`'s `x-deny`):
 *
 * - `boolean-false` — `enabled: false`. Resolution below.
 * - `array-union` — `disabledServers: ["x"]`. The union of every tier's
 *   members, always. There is no vocabulary for UN-denying a member, so a
 *   nearer tier that omits one is expressing nothing, not an allow. This is the
 *   one place `x-merge-strategy` does not decide the outcome: a `replace`
 *   strategy still governs how the array is SPELLED across tiers, and the deny
 *   union still governs which members survive. A deny that a merge strategy
 *   could erase would not be monotonic.
 *
 * Pure functions over their arguments. No state, no ledger writes: a denial
 * being honored is the normal case, not a degradation.
 */

import type { ConfigValue } from "./schema.js";
import {
	isRepoTier,
	type Provenance,
	type SourceTier,
	tierPrecedence,
	type TrustDecision,
} from "./provenance.js";

/** One tier's contribution to a single deny-annotated leaf. */
export interface DenyContribution {
	readonly tier: SourceTier;
	readonly file?: string;
	readonly trust?: TrustDecision;
	readonly value: ConfigValue | undefined;
}

/** The resolved leaf plus the contribution that explains it. */
export interface DenyResolution {
	readonly value: ConfigValue | undefined;
	/** Index into the contributions array; -1 when there were none. */
	readonly winner: number;
	/** True when a denial is in force and no nearer tier could lift it. */
	readonly denied: boolean;
}

/** Build a provenance entry for a resolved deny leaf. */
export function denyProvenance(
	contributions: readonly DenyContribution[],
	resolution: DenyResolution,
	key: string,
): Provenance | undefined {
	const source = contributions[resolution.winner];
	if (!source) return undefined;
	return {
		tier: source.tier,
		key,
		...(source.file === undefined ? {} : { file: source.file }),
		...(source.trust === undefined ? {} : { trust: source.trust }),
	};
}

/** Contributions sorted by tier precedence, lowest first, ties in caller order. */
function byPrecedence(
	contributions: readonly DenyContribution[],
): Array<{ contribution: DenyContribution; index: number }> {
	return contributions
		.map((contribution, index) => ({ contribution, index }))
		.sort(
			(left, right) =>
				tierPrecedence(left.contribution.tier) -
				tierPrecedence(right.contribution.tier),
		);
}

/**
 * Resolve a `boolean-false` deny.
 *
 * - No `false` anywhere: ordinary last-tier-wins.
 * - An operator tier said `false`: DENIED, pinned. The winner is the
 *   LOWEST-precedence operator denial, because that is the answer to "who
 *   denied this" — the first authority to say no, not the last tier to repeat
 *   it.
 * - Only repo tiers said `false`: denied, unless an operator tier of HIGHER
 *   precedence than that denial explicitly said `true`. An operator overriding
 *   repository content is the one legitimate lift.
 *
 * Non-boolean contributions are ignored here: `normalize.ts` has already
 * dropped values that failed the schema, so anything left is a boolean.
 */
export function resolveBooleanDeny(
	contributions: readonly DenyContribution[],
): DenyResolution {
	const ordered = byPrecedence(contributions);
	if (ordered.length === 0)
		return { value: undefined, winner: -1, denied: false };

	const denials = ordered.filter((entry) => entry.contribution.value === false);
	if (denials.length === 0) {
		const last = ordered[ordered.length - 1];
		return {
			value: last.contribution.value,
			winner: last.index,
			denied: false,
		};
	}

	const operatorDenial = denials.find(
		(entry) => !isRepoTier(entry.contribution.tier),
	);
	if (operatorDenial) {
		return { value: false, winner: operatorDenial.index, denied: true };
	}

	// Every denial came from repo content. An operator tier ranked above the
	// FIRST such denial may lift it by saying `true` outright.
	const firstDenial = denials[0];
	const lift = ordered.find(
		(entry) =>
			entry.contribution.value === true &&
			!isRepoTier(entry.contribution.tier) &&
			tierPrecedence(entry.contribution.tier) >
				tierPrecedence(firstDenial.contribution.tier),
	);
	if (lift) return { value: true, winner: lift.index, denied: false };
	return { value: false, winner: firstDenial.index, denied: true };
}

/**
 * Resolve an `array-union` deny: the union of every tier's members.
 *
 * Members keep first-contribution order, lowest precedence first, so the
 * resolved list reads oldest-authority-first and is stable across runs.
 * Duplicates are folded by their JSON encoding, which is exact for the
 * primitives a deny list holds and conservative (keeps both) for anything else.
 *
 * The winner is the FIRST tier that contributed a surviving member: the tier
 * that answers "why can I not turn this back on".
 */
export function resolveArrayDeny(
	contributions: readonly DenyContribution[],
): DenyResolution {
	const ordered = byPrecedence(contributions);
	const seen = new Set<string>();
	const members: ConfigValue[] = [];
	let winner = -1;
	for (const entry of ordered) {
		const value = entry.contribution.value;
		if (!Array.isArray(value)) continue;
		for (const member of value) {
			const identity = primitiveIdentity(member);
			if (identity !== undefined) {
				if (seen.has(identity)) continue;
				seen.add(identity);
			}
			members.push(member);
			if (winner === -1) winner = entry.index;
		}
	}
	if (winner === -1) {
		// Nothing denied. Still report the array so a consumer sees an empty list
		// rather than an absent field, and attribute it to the last contributor.
		const last = ordered[ordered.length - 1];
		return {
			value: members,
			winner: last ? last.index : -1,
			denied: false,
		};
	}
	return { value: members, winner, denied: members.length > 0 };
}

/**
 * A fold key for a primitive member, or `undefined` for anything else.
 *
 * Only primitives are de-duplicated. Two structurally equal objects can carry
 * different meaning, and keeping both is the conservative half of a deny list —
 * a union that dropped one would be un-denying something.
 */
function primitiveIdentity(member: ConfigValue): string | undefined {
	if (typeof member === "string") return `s:${member}`;
	if (typeof member === "number" || typeof member === "boolean") {
		return `p:${String(member)}`;
	}
	if (member === null) return "null";
	return undefined;
}
