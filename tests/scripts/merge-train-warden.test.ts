import { describe, expect, it } from "vitest";
import {
	applyAction,
	classifyActionFailure,
	CONFLICT_LABEL,
	decideActions,
	fetchOpenPullRequests,
	MAX_PAGES,
	PAGE_SIZE,
	RED_CI_LABEL,
	runWarden,
} from "../../scripts/lib/merge-train-warden.mjs";

function pr(overrides: Record<string, unknown> = {}) {
	return {
		number: 1,
		url: "https://github.com/acme/repo/pull/1",
		headSha: "abc123",
		mergeStateStatus: "CLEAN",
		autoMergeEnabled: false,
		isFork: false,
		labels: new Set<string>(),
		checksUnknown: false,
		failingRequiredChecks: [] as Array<{ name: string; url?: string }>,
		unresolvedRequiredChecks: [] as string[],
		...overrides,
	};
}

describe("merge-train warden decision logic (#1844)", () => {
	it("labels and comments once when a clean PR turns DIRTY", () => {
		const actions = decideActions(pr({ mergeStateStatus: "DIRTY" }));
		expect(actions).toEqual([
			{ type: "add-label", label: CONFLICT_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("merge-conflicted"),
			}),
		]);
	});

	// Dedupe by label presence: mutating this to `false` (always re-add/comment)
	// must turn this test red -- that is the vacuous-guard screen.
	it("does not re-label or re-comment a PR already labeled conflict", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "DIRTY", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("removes the conflict label once the PR is confirmed clean again", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "CLEAN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([{ type: "remove-label", label: CONFLICT_LABEL }]);
	});

	// Review round 1, F1: GitHub reports UNKNOWN for every open PR for a few
	// seconds after each push while it recomputes mergeability. Treating that
	// as "clean again" would strip the label, then immediately re-add it and
	// re-comment on the very next 10-minute tick.
	it("takes no conflict action while mergeStateStatus is UNKNOWN, even with the label present", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "UNKNOWN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("takes no conflict action while mergeStateStatus is UNKNOWN and unlabeled", () => {
		const actions = decideActions(pr({ mergeStateStatus: "UNKNOWN" }));
		expect(actions).toEqual([]);
	});

	it("kicks update-branch only when auto-merge is armed AND the PR is BEHIND", () => {
		expect(
			decideActions(pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: true })),
		).toContainEqual({ type: "update-branch" });
		expect(
			decideActions(
				pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: false }),
			),
		).not.toContainEqual({ type: "update-branch" });
		expect(
			decideActions(pr({ mergeStateStatus: "CLEAN", autoMergeEnabled: true })),
		).not.toContainEqual({ type: "update-branch" });
	});

	it("labels and comments once when a required check fails, naming it with its run link", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/9" },
				],
			}),
		);
		expect(actions).toEqual([
			{ type: "add-label", label: RED_CI_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("Unit tests"),
			}),
		]);
		const commentAction = actions[1] as { body: string };
		expect(commentAction.body).toContain("https://example/run/9");
	});

	it("does not re-label or re-comment a PR already labeled red-ci", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [{ name: "Unit tests" }],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	it("removes red-ci once every required check has a settled non-failure conclusion", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// Review round 1, F3: a re-queued required check reports conclusion null
	// while it reruns. Reading that as "not failing" (empty
	// failingRequiredChecks) would flap the label off and re-comment on the
	// next failure, once per re-run.
	it("does not remove red-ci while a previously-failing required check is unresolved (re-queued)", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: ["Unit tests"],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	// Review round 1, F2: a null/absent statusCheckRollup is missing
	// information, not evidence of a clean run. Must not silently strip an
	// existing red-ci label; must record why so "confirmed green" and
	// "didn't check" stay distinguishable in the run summary (an
	// empty-vs-errored guard).
	it("does not remove red-ci when the rollup is unknown, and records why", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("statusCheckRollup missing"),
			},
		]);
	});

	it("takes no red-ci action when the rollup is unknown and the PR is not labeled (nothing to protect)", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
			}),
		);
		expect(actions).toEqual([]);
	});

	it("still removes red-ci on a genuinely all-green rollup (checksUnknown false) -- distinct from the unknown-rollup case", () => {
		const actions = decideActions(
			pr({
				checksUnknown: false,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// #1959: a 403 on update-branch means two very different things depending
	// on whose branch it is. Deleting the `pr.isFork` check here (so every
	// update-branch 403 reads as benign) must turn the own-branch case below
	// red -- that is the mutation-proof screen for this branch.
	it("classifies an update-branch 403 on a fork-owned PR as the distinct benign fork outcome", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: true }),
			403,
		);
		expect(result).toEqual({
			benign: true,
			outcome: "update-branch-forbidden-fork",
		});
	});

	it("classifies an update-branch 403 on an own-branch PR as fatal, not benign", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: false }),
			403,
		);
		expect(result).toEqual({ benign: false, outcome: null });
	});

	it("leaves every other action/status pair on the existing benign-status set", () => {
		expect(
			classifyActionFailure(
				{ type: "add-label", label: CONFLICT_LABEL },
				pr({ isFork: true }),
				403,
			),
		).toEqual({ benign: false, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: true }),
				422,
			),
		).toEqual({ benign: true, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: false }),
				404,
			),
		).toEqual({ benign: true, outcome: null });
	});

	it("never proposes a merge or a push -- only label, comment, note, and the sanctioned update-branch kick", () => {
		const allowed = new Set([
			"add-label",
			"remove-label",
			"comment",
			"update-branch",
			"note",
		]);
		for (const state of [
			"DIRTY",
			"BEHIND",
			"CLEAN",
			"BLOCKED",
			"UNSTABLE",
			"UNKNOWN",
		]) {
			for (const auto of [true, false]) {
				const actions = decideActions(
					pr({
						mergeStateStatus: state,
						autoMergeEnabled: auto,
						failingRequiredChecks: [{ name: "Unit tests" }],
					}),
				);
				for (const action of actions)
					expect(allowed.has(action.type)).toBe(true);
			}
		}
	});
});

function fakeGithub(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetcher = async (
		url: string,
		init?: { method?: string; body?: string },
	) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		const key = `${method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
		const entry = routes[key];
		if (entry === undefined)
			return { ok: true, status: 200, json: async () => ({}) };
		if (typeof entry === "function") return entry(body);
		return { ok: true, status: 200, json: async () => entry };
	};
	return { fetcher, calls };
}

function checkRun(
	name: string,
	conclusion: string | null,
	detailsUrl = `https://example/${name}`,
) {
	return { __typename: "CheckRun", name, conclusion, detailsUrl };
}

function graphqlPage(
	nodes: unknown[],
	hasNextPage = false,
	endCursor: string | null = null,
) {
	return {
		data: {
			repository: {
				pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes },
			},
		},
	};
}

function prNode(overrides: Record<string, unknown> = {}) {
	return {
		number: 7,
		url: "https://github.com/acme/repo/pull/7",
		mergeStateStatus: "DIRTY",
		autoMergeRequest: null,
		labels: { nodes: [] },
		commits: {
			nodes: [
				{
					commit: {
						oid: "deadbeef",
						statusCheckRollup: { contexts: { nodes: [] } },
					},
				},
			],
		},
		...overrides,
	};
}

describe("merge-train warden GraphQL fetch + REST apply (#1844)", () => {
	it("normalizes a GraphQL page into flat PR records with failing required checks", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun(
												"Unit tests",
												"FAILURE",
												"https://example/run/1",
											),
											checkRun(
												"Lint & type-check",
												"SUCCESS",
												"https://example/run/2",
											),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(errors).toEqual([]);
		expect(prs).toEqual([
			expect.objectContaining({
				number: 7,
				mergeStateStatus: "DIRTY",
				headSha: "deadbeef",
				autoMergeEnabled: false,
				checksUnknown: false,
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/1" },
				],
				unresolvedRequiredChecks: [],
			}),
		]);
	});

	// Review round 1, F5: the required-checks filter must actually filter.
	// Deleting the `REQUIRED_CHECKS.includes(c.name)` guard in normalizePr
	// (so any failing check counts, including non-required ones) must turn
	// this test red.
	it("ignores a failing check that is not in REQUIRED_CHECKS (e.g. SonarCloud)", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [checkRun("SonarCloud Code Analysis", "FAILURE")],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("marks a required check missing from the rollup as unresolved, not passing", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", "SUCCESS")] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual(["Lint & type-check"]);
	});

	it("marks a re-queued required check (conclusion null) as unresolved", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", null)] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].unresolvedRequiredChecks).toContain("Unit tests");
		expect(prs[0].failingRequiredChecks).toEqual([]);
	});

	it("flags checksUnknown when statusCheckRollup is null", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [{ commit: { oid: "deadbeef", statusCheckRollup: null } }],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].checksUnknown).toBe(true);
	});

	it("bails gracefully on a malformed page instead of throwing", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: { repository: { pullRequests: { nodes: "not-an-array" } } },
			},
		});
		await expect(
			fetchOpenPullRequests(fetcher, "acme", "repo"),
		).resolves.toEqual({ prs: [], errors: [] });
	});

	// Review round 1, F6: GraphQL can return partial `data` alongside
	// `errors`. This must be skip-and-record, not an uncaught throw out of
	// the bare top-level await in the CLI entry point.
	it("records GraphQL errors instead of throwing, keeping any partial data collected", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [prNode({ number: 1 })],
						},
					},
				},
				errors: [{ message: "some field errored" }],
			},
		});
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toHaveLength(1);
		expect(errors[0]).toContain("some field errored");
	});

	it("records a thrown GraphQL request failure instead of propagating", async () => {
		const fetcher = async () => {
			throw new Error("network down");
		};
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toEqual([]);
		expect(errors[0]).toContain("network down");
	});

	// #2134: a full final page with hasNextPage is not an exhausted result.
	// The page-aware fixture makes a cursor bug visible instead of returning
	// the same page for every request.
	it("records truncation when MAX_PAGES pages still claim another page", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				true,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([
			`GraphQL pagination truncated after ${MAX_PAGES} pages while hasNextPage=true`,
		]);
	});

	// The page limit is healthy when the final page exhausts the connection.
	// Hoisting the truncation guard above the hasNextPage break must make this
	// complete population report a false error.
	it("accepts MAX_PAGES full pages when the last page is exhausted", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				pageIndex < MAX_PAGES - 1,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([]);
	});

	it("applyAction issues the exact REST call for each action type", async () => {
		const { fetcher, calls } = fakeGithub({});
		const record = pr({ number: 5, headSha: "abc123" });
		await applyAction(fetcher, "acme", "repo", record, {
			type: "add-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "remove-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "comment",
			body: "hi",
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "update-branch",
		});
		expect(calls).toEqual([
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels",
				body: { labels: [CONFLICT_LABEL] },
			},
			{
				method: "DELETE",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels/conflict",
				body: undefined,
			},
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/comments",
				body: { body: "hi" },
			},
			{
				method: "PUT",
				url: "https://api.github.com/repos/acme/repo/pulls/5/update-branch",
				body: { expected_head_sha: "abc123" },
			},
		]);
	});

	it("records one PR's API failure without aborting the sweep over the rest", async () => {
		const page = graphqlPage([
			prNode({ number: 1, url: "u1" }),
			prNode({ number: 2, url: "u2" }),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toHaveLength(2);
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 500"), benign: false },
		]);
		expect(results[1].errors).toEqual([]);
		expect(results[1].applied).toContain(`add-label:${CONFLICT_LABEL}`);
	});

	// Review round 1, F4: a closed/deleted PR (404), a racing label add (409),
	// or an update-branch on a fork with maintainer edits off (422) are
	// expected noise on a 10-minute cadence -- they must be recorded but must
	// NOT be counted as a reason for the scheduled run to exit non-zero.
	it("classifies 404/409/422 REST failures as benign, and everything else as fatal", async () => {
		const page = graphqlPage([prNode({ number: 1 })]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 404,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 404"), benign: true },
		]);
	});

	// #1959, AC2: the run-level classification must actually reach runWarden's
	// error stream, not just the pure classifyActionFailure unit above.
	it("records an update-branch 403 on a fork-owned BEHIND PR as benign with the fork outcome, not a failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: true,
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{
				message: expect.stringContaining("update-branch-forbidden-fork"),
				benign: true,
			},
		]);
		// Review round 2, F2: this is the wiring guard for isFork itself.
		// Deleting `isCrossRepository` from PR_QUERY leaves normalizePr's
		// `Boolean(node.isCrossRepository)` silently reading `undefined` as
		// `false` on every real PR -- the whole fork branch above would then
		// go dead in production while every one of these tests (which fake
		// the GraphQL response by hand) stays green. Assert the query text
		// itself requests the field, so removing it fails here first.
		const graphqlCall = calls.find((c) => c.url.endsWith("/graphql"));
		expect(
			String((graphqlCall?.body as { query?: string } | undefined)?.query),
		).toContain("isCrossRepository");
	});

	it("records an update-branch 403 on an own-branch BEHIND PR as a fatal failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: false,
			}),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 403"), benign: false },
		]);
	});

	it("records a list-level GraphQL error as its own result entry with number: null", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: null,
				errors: [{ message: "resource not accessible" }],
			},
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toEqual([
			{
				number: null,
				url: null,
				mergeStateStatus: null,
				applied: [],
				errors: [
					{
						message: expect.stringContaining("resource not accessible"),
						benign: false,
					},
				],
			},
		]);
	});
});
