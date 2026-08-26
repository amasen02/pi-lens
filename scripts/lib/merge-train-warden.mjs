/**
 * Merge-train warden (#1844): the mechanical version of the checks a human
 * was running session-side across the 2026-08-20 release drive -- polling
 * open PRs for merge conflicts, stale auto-merge, and red required checks.
 *
 * The warden OBSERVES AND ANNOTATES ONLY. It never resolves conflicts,
 * never merges, and never pushes to a PR branch. The one exception is the
 * GitHub-sanctioned "update branch" kick for a PR that already has auto-merge
 * armed and has fallen BEHIND -- that is the same button a human clicks in
 * the PR UI, exposed here as the API GitHub documents for it.
 */

export const CONFLICT_LABEL = "conflict";
export const RED_CI_LABEL = "red-ci";
export const REQUIRED_CHECKS = ["Unit tests", "Lint & type-check"];
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4; // 200 open PRs is far above this repo's steady state; bail rather than loop forever.
// Recorded-but-ok REST failures (review round 1, F4): a closed/deleted PR
// (404), a label-add racing another tick (409), or update-branch on a fork
// with maintainer edits off / already up to date (422) are expected noise on
// a 10-minute cadence, not warden bugs. Only a status OUTSIDE this set marks
// the scheduled run red, so the run doesn't email every 10 minutes for
// benign races.
const BENIGN_HTTP_STATUSES = new Set([404, 409, 422]);

const PR_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        url
        mergeStateStatus
        autoMergeRequest { enabledAt }
        isCrossRepository
        labels(first: 50) { nodes { name } }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      detailsUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Returns the raw GraphQL payload ({ data, errors }) instead of throwing on
// `errors` (review round 1, F6): GraphQL can return PARTIAL data alongside
// errors, and the caller decides how to treat that -- collapsing straight to
// a throw would crash the bare top-level await in the CLI entry point and
// lose the whole run's summary instead of skipping the affected page.
async function graphql(fetcher, query, variables) {
	const response = await fetcher("https://api.github.com/graphql", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) throw new Error(`GitHub GraphQL API ${response.status}`);
	return response.json();
}

function normalizePr(node) {
	const labels = new Set((node.labels?.nodes ?? []).map((l) => l.name));
	const headCommit = node.commits?.nodes?.[0]?.commit;
	const rollup = headCommit?.statusCheckRollup;
	// A null/absent rollup (review round 1, F2) is NOT the same as "zero
	// failing checks" -- it means GitHub hasn't told us anything about the
	// head commit's checks yet (permissions gap, brand-new commit, API hiccup).
	// Collapsing that to "clean" would strip an existing red-ci label on pure
	// absence of information. checksUnknown lets decideActions distinguish
	// "confirmed no failures" from "we don't know".
	const checksUnknown = rollup == null;
	const contexts = rollup?.contexts?.nodes ?? [];
	const checkRunsByName = new Map();
	for (const c of contexts) {
		if (c.__typename === "CheckRun") checkRunsByName.set(c.name, c);
	}
	const failingRequiredChecks = [];
	// A required check that hasn't reported yet (absent from the rollup) or is
	// mid-run (conclusion null: queued/in-progress/re-queued) is UNRESOLVED,
	// not "not failing" (review round 1, F3). Only a settled non-FAILURE
	// conclusion counts as positive evidence of passing.
	//
	// The REQUIRED_CHECKS loop below is the ONLY filter that keeps a failing
	// non-required check (e.g. SonarCloud) from tripping red-ci (review round
	// 1, F5) -- it looks up exactly the required names, ignoring every other
	// key checkRunsByName may hold.
	const unresolvedRequiredChecks = [];
	for (const name of REQUIRED_CHECKS) {
		const run = checkRunsByName.get(name);
		if (!run) unresolvedRequiredChecks.push(name);
		else if (run.conclusion === "FAILURE")
			failingRequiredChecks.push({ name, url: run.detailsUrl });
		else if (!run.conclusion) unresolvedRequiredChecks.push(name);
	}
	return {
		number: node.number,
		url: node.url,
		headSha: headCommit?.oid,
		mergeStateStatus: node.mergeStateStatus,
		autoMergeEnabled: Boolean(node.autoMergeRequest),
		// isCrossRepository is GitHub's own fork signal: true when the PR's head
		// repository differs from this (base) repository. update-branch's PUT
		// creates a commit ON the head branch, so a fork-owned head is the
		// expected 403 case -- the workflow token can label/comment on the PR
		// without ever having write access to someone else's repository (#1959).
		isFork: Boolean(node.isCrossRepository),
		labels,
		checksUnknown,
		failingRequiredChecks,
		unresolvedRequiredChecks,
	};
}

/**
 * Single paginated list call (per PR, bounded by MAX_PAGES): rate-limit
 * conscious by construction. If GitHub returns a non-array/malformed page,
 * a request throws, or a page comes back with partial `errors`, bail
 * gracefully with whatever PRs were already collected plus a recorded error
 * -- never throw out of this function (review round 1, F6).
 */
export async function fetchOpenPullRequests(fetcher, owner, name) {
	const prs = [];
	const errors = [];
	const seenNumbers = new Set();
	let after;
	for (let page = 0; page < MAX_PAGES; page++) {
		let payload;
		try {
			payload = await graphql(fetcher, PR_QUERY, { owner, name, after });
		} catch (error) {
			errors.push(
				`GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
		if (payload?.errors?.length)
			errors.push(
				`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`,
			);
		const connection = payload?.data?.repository?.pullRequests;
		if (!connection || !Array.isArray(connection.nodes)) break;
		for (const node of connection.nodes) {
			if (seenNumbers.has(node.number)) {
				errors.push(
					`GraphQL pagination repeated PR #${node.number} across pages; collection may be incomplete`,
				);
				continue;
			}
			seenNumbers.add(node.number);
			prs.push(normalizePr(node));
		}
		if (!connection.pageInfo?.hasNextPage) break;
		const nextCursor = connection.pageInfo.endCursor;
		if (nextCursor == null || nextCursor === after) {
			errors.push(
				"GraphQL pagination truncated because cursor did not advance",
			);
			break;
		}
		if (page === MAX_PAGES - 1) {
			errors.push(
				`GraphQL pagination truncated after ${MAX_PAGES} pages while hasNextPage=true`,
			);
			break;
		}
		after = nextCursor;
	}
	return { prs, errors };
}

/**
 * Decide what the warden should do for one PR. Pure function, no I/O --
 * this is what a test drives without a network mock. Dedupe is structural:
 * a comment is proposed only on the transition INTO a labeled state (label
 * absent -> label needed), never while the label already sits on the PR.
 * A human removing the label manually re-arms the next comment -- that is
 * the label's whole job as the dedupe key, so the comment body itself
 * carries no separate marker to scan for (review round 1, F9).
 */
export function decideActions(pr) {
	const actions = [];
	const isDirty = pr.mergeStateStatus === "DIRTY";
	// Recovery requires a POSITIVELY KNOWN non-DIRTY state (review round 1,
	// F1). GitHub reports mergeStateStatus: UNKNOWN for every open PR for a
	// few seconds after each push while it recomputes mergeability -- treating
	// that as "clean again" would strip the conflict label and then
	// immediately re-add it plus re-comment on the very next tick.
	const isConfirmedNotDirty =
		pr.mergeStateStatus !== "DIRTY" && pr.mergeStateStatus !== "UNKNOWN";
	const hasConflictLabel = pr.labels.has(CONFLICT_LABEL);
	if (isDirty && !hasConflictLabel) {
		actions.push({ type: "add-label", label: CONFLICT_LABEL });
		actions.push({
			type: "comment",
			body: "This PR is merge-conflicted; required checks are silently skipped until resolved.",
		});
	} else if (isConfirmedNotDirty && hasConflictLabel) {
		actions.push({ type: "remove-label", label: CONFLICT_LABEL });
	}
	// mergeStateStatus: UNKNOWN + label present falls through both branches
	// above: no action either direction, by construction.

	if (pr.autoMergeEnabled && pr.mergeStateStatus === "BEHIND") {
		actions.push({ type: "update-branch" });
	}

	const hasRedCiLabel = pr.labels.has(RED_CI_LABEL);
	if (pr.checksUnknown) {
		// Can't tell clean from errored (review round 1, F2): never strip an
		// existing red-ci label on missing data, and record why so the run
		// summary distinguishes "confirmed green" from "didn't check".
		if (hasRedCiLabel) {
			actions.push({
				type: "note",
				benign: true,
				message: `PR #${pr.number}: statusCheckRollup missing on the head commit; red-ci recovery check skipped this run`,
			});
		}
	} else if (pr.failingRequiredChecks.length > 0 && !hasRedCiLabel) {
		actions.push({ type: "add-label", label: RED_CI_LABEL });
		const lines = pr.failingRequiredChecks.map(
			(c) => `- **${c.name}** failed${c.url ? ` — ${c.url}` : ""}`,
		);
		actions.push({
			type: "comment",
			body: `A required check is failing on the current head:\n\n${lines.join("\n")}`,
		});
	} else if (
		pr.failingRequiredChecks.length === 0 &&
		pr.unresolvedRequiredChecks.length === 0 &&
		hasRedCiLabel
	) {
		// Only remove once every required check has a SETTLED non-failure
		// conclusion. A re-queued check (conclusion null) stays in
		// unresolvedRequiredChecks, so this branch does not fire and the label
		// does not flap while the re-run is in flight (review round 1, F3).
		actions.push({ type: "remove-label", label: RED_CI_LABEL });
	}

	return actions;
}

// update-branch's 403 nuance (#1959): a 403 on a fork-owned PR is the
// workflow token correctly lacking write access to someone else's
// repository -- expected, not a bug, so it is recorded as a distinct benign
// outcome rather than folded into the generic BENIGN_HTTP_STATUSES set (a
// blanket 403->benign would also swallow the real bug this issue reports: a
// 403 on an OWN-branch PR means the token itself lacks contents: write, and
// that must stay loud and fail the run. Every other action/status pair falls
// through to the existing benign-status set unchanged.
//
// Pure and separate from decideActions on purpose: decideActions decides
// WHAT to do (never sees HTTP responses); this decides how to read a
// response AFTER the fact, so it is unit-testable without a network mock,
// same as decideActions.
export function classifyActionFailure(action, pr, status) {
	if (action.type === "update-branch" && status === 403 && pr.isFork) {
		return { benign: true, outcome: "update-branch-forbidden-fork" };
	}
	return { benign: BENIGN_HTTP_STATUSES.has(status), outcome: null };
}

async function restJson(fetcher, method, url, body) {
	const response = await fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return response;
}

/**
 * Apply one decided action against the REST API. Every failure is caught by
 * the caller (runWarden) and recorded per-PR -- one PR's API hiccup must
 * never abort the run for every other open PR. "note" actions carry no API
 * call and are recorded directly by runWarden.
 */
export async function applyAction(fetcher, owner, repo, pr, action) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	switch (action.type) {
		case "add-label":
			return restJson(fetcher, "POST", `${base}/issues/${pr.number}/labels`, {
				labels: [action.label],
			});
		case "remove-label":
			return restJson(
				fetcher,
				"DELETE",
				`${base}/issues/${pr.number}/labels/${encodeURIComponent(action.label)}`,
			);
		case "comment":
			return restJson(fetcher, "POST", `${base}/issues/${pr.number}/comments`, {
				body: action.body,
			});
		case "update-branch":
			return restJson(
				fetcher,
				"PUT",
				`${base}/pulls/${pr.number}/update-branch`,
				{ expected_head_sha: pr.headSha },
			);
		default:
			throw new Error(`unknown warden action type: ${action.type}`);
	}
}

/**
 * Run the warden over every open PR. Returns a per-PR log so the caller can
 * print a run summary; a PR whose API calls fail is recorded but does not
 * stop the sweep over the rest of the list. Each recorded error carries a
 * `benign` flag (review round 1, F4): a benign HTTP status (see
 * BENIGN_HTTP_STATUSES) or a "note" is expected noise, never cause for the
 * scheduled run itself to go red; anything else is a real failure.
 */
export async function runWarden({ fetcher, owner, repo }) {
	const { prs, errors: listErrors } = await fetchOpenPullRequests(
		fetcher,
		owner,
		repo,
	);
	const results = [];
	if (listErrors.length > 0) {
		results.push({
			number: null,
			url: null,
			mergeStateStatus: null,
			applied: [],
			errors: listErrors.map((message) => ({ message, benign: false })),
		});
	}
	for (const pr of prs) {
		const actions = decideActions(pr);
		const applied = [];
		const errors = [];
		for (const action of actions) {
			if (action.type === "note") {
				errors.push({ message: action.message, benign: action.benign ?? true });
				continue;
			}
			try {
				const response = await applyAction(fetcher, owner, repo, pr, action);
				if (!response.ok) {
					const classification = classifyActionFailure(
						action,
						pr,
						response.status,
					);
					const suffix = classification.outcome
						? ` (${classification.outcome})`
						: "";
					const message =
						`${action.type} ${action.label ?? ""} -> HTTP ${response.status}${suffix}`.trim();
					errors.push({ message, benign: classification.benign });
				} else {
					applied.push(action.type + (action.label ? `:${action.label}` : ""));
				}
			} catch (error) {
				errors.push({
					message: `${action.type} -> ${error instanceof Error ? error.message : String(error)}`,
					benign: false,
				});
			}
		}
		results.push({
			number: pr.number,
			url: pr.url,
			mergeStateStatus: pr.mergeStateStatus,
			applied,
			errors,
		});
	}
	return results;
}
