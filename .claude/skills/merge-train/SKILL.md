---
name: merge-train
description: Run the pi-lens review → verify → merge policy over one or more open PRs. Use when asked to land a PR, babysit the merge queue, or process review backlogs. Encodes the standing quality gates so any session applies the same discipline.
---

# Merge train

The policy that landed the 2026-08-17 arc (11 PRs, every one adversarially
reviewed, zero unreviewed merges). Apply it to each PR in the queue.

## The loop, per PR

1. **Review.** Spawn `pi-lens-reviewer` (worktree isolation) with the PR
   number, a one-paragraph summary of the claim, and any PR-specific attack
   angles. Self-authored and small PRs get reviewed too — no exceptions.
2. **Fix rounds.** Send findings back to the PR's original author agent when
   its worktree survives (SendMessage — cheapest context); otherwise spawn
   `pi-lens-fixer` on the branch with the findings inlined.
   **Since #2486, `SubagentStop` REAPS the stopped agent's own worktree**
   (maintainer decision, 2026-09-02, reversing the earlier "never removes
   here" rule, which left ten stale trees in one afternoon). So by default an
   agent's tree is gone the moment it finishes, and SendMessage to it lands on
   a branch with no checkout. Its branch survives — a tree is never removed
   unless its HEAD is already in an `origin/*` ref — so nothing committed is
   lost and a fresh `pi-lens-fixer` on the branch always works. If this
   session intends to resume fixers by SendMessage, export
   `PILENS_HYGIENE_KEEP_AGENT_TREES=1` for the session (or add
   `--keep-agent-tree` to the registered hook) and the reap is off.
   Kept trees are then reaped by the `SessionStart` sweep —
   which runs on `startup` and `resume` only, not on `/clear`, compaction or a
   fork — once they have been idle ≥30m and are clean and pushed. Idle is
   measured from the checkout directory and the worktree's HEAD (and its
   reflog), never from the git index, so the sweep's own dirty check cannot
   make a finished tree look busy.
   A tree with uncommitted work, or with work not yet on an `origin/*` ref, is
   never removed at any age, by any sweep — so a fix round in flight is safe by
   its own state, not by the clock.
3. **Verify.** The SAME reviewer verifies each fix round with its own probes.
   Do not take the fixer's word; do not swap reviewers mid-PR. A reviewer's
   worktree is an `agent-*` tree too, so once its report lands the tree is
   clean+pushed and `SubagentStop` reaps it exactly like a fixer's — a
   SendMessage resume finds no checkout, same as above. Recreate it: the
   merge-train practice is a FRESH reviewer worktree per VERIFY round, not a
   kept one. Continuity is the reviewer AGENT (SendMessage still reaches the
   same identity, so the same judgment and probes carry over); the checkout
   under it is expected to be rebuilt each round, not preserved. Do not set
   `--keep-agent-tree` / `PILENS_HYGIENE_KEEP_AGENT_TREES=1` merely to dodge
   this — that decision stays off by default (see step 2).
4. **Merge gate.** Merge only when: verdict is merge-ready; Unit tests and
   Lint genuinely EXECUTED and passed on the exact head SHA
   (`node scripts/ci-verdict.mjs <pr-number|sha>` — a DIRTY PR silently skips
   them, absent is not green); every failing check
   was read and judged (infra failures — codeload 429/503, SARIF-upload
   errors, Initialize-CodeQL outages — may be waved through only with the
   log read and the judgment recorded).
5. **Merge.** `gh pr merge <N> --merge` (merge commit, repo convention).
   If "not up to date", `gh api -X PUT .../pulls/<N>/update-branch`, wait for
   CI, re-gate, merge. On GitHub 503s: retry with backoff, never switch to
   raw-API merge endpoints.
   Alternative, once the verdict is in: apply the `train:approved` label (add
   `train:squash` for a squash merge) and let the merge-train lane workflow
   land it (#2185). The lane merges only when both required checks have
   CONCLUDED success on the exact current head, so a fix round pushed after
   labeling re-gates itself. Removing the label aborts. Steps 1 through 4 are
   unchanged: only the maintainer applies the label, and only after the
   review verdict.
6. **After each merge.** Master moved: check other open PRs for BEHIND/DIRTY,
   check in-flight agents for file overlap with the merged diff and nudge
   affected ones to merge origin/master before their next push.

## Queue ordering

Order by dependency, not age: a PR whose schema/API another PR must consume
merges first (the consumer then rebases and wires the new surface). Two PRs
editing the same file get an explicit order decided up front. Log-schema
changes must extend exact-key pins (`BASELINE_KEYS`-style), never loosen them.

## Quota gate (orchestrator)

Before ANY new dispatch (not a fix round on an open PR): know the account's
5h and weekly usage. Above 75% of the 5h window or 85% of the weekly window,
no new work — finish in-flight lanes and merge on green. The numbers are
readable live: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth
token from `~/.claude/.credentials.json` (`anthropic-beta: oauth-2025-04-20`)
returns `five_hour.utilization` / `seven_day.utilization` and reset times; the
`~/.claude/hooks/quota-gate.mjs` PreToolUse hook on `Agent` reads them and
blocks dispatch above the thresholds (no hand-written fallback;
`QUOTA_GATE_OVERRIDE=1` lifts it when the maintainer says so). Read the meters at session start and before
every refill; state them in the lane ledger. Standing rule from
2026-09-03, lifted only when the maintainer says so.

## Brief contract (orchestrator)

Before dispatching any issue that adds a shared helper or seam: grep for
same-shape siblings yourself and write the fold into the SAME slice, or write
the sibling list, the reason folding is unsafe in one PR, and the follow-up
issue into the brief. AGENTS.md's net-count rule binds the brief author; the
fixer and reviewer only enforce what the brief scoped. #2530 shipped a fifth
bound helper because the brief deferred the fold without a reason.

## Filing issues (orchestrator)

Every `gh issue create` carries one TYPE label, at least one `area:*`, and
exactly one `priority:p1|p2|p3` (AGENTS.md #1676 rubric). The priority labels
were found deleted from the repo on 2026-09-03 and recreated (#2553); an
issue filed without one is a triage defect, not a shortcut.

## Round-count rail (orchestrator)

When a verify round reports that a fix round introduced a NEW defect on the
same record or seam (not merely left one), the next fix brief opens with
AGENTS.md's state-space step — invariants, writers × axes, the cell list —
written into the PR body BEFORE any edit, and the fixer is Opus. Never send a
third patch-only round: #2528 went r2 → r3 → r4 on one cache record, each
round fixing three findings and adding two, until the model was demanded.

## Orchestrator invariants (any orchestrator, not only Claude)

These are the habits the train depends on. They live here, not in any one
operator's private notes, so a different orchestrator can run the same train.

- **Contracts move in the same session.** When a review or a dogfood finding
  reveals a defect CLASS (not an instance), add a numbered shape to AGENTS.md's
  catalog with the issue ref and a one-line screen, extend the fixer's screen
  list, and cite the number in the next brief — before the next dispatch. "To
  err twice is not the mark of a wise man." (2026-09-03: shapes 28–36 came out
  of one day's reviews this way.)
- **Keep a lane ledger.** One file, one row per lane: issue/PR, worker id,
  round, state, head SHA, merge-order note; a header line with the quota
  reading and the merged list. Update it on every dispatch, report and merge.
  It is what survives a context reset.
- **A lane's worktree lives until its PR merges.** Pruning it after a report
  makes the owning worker un-resumable, so every fix round then costs a fresh
  worker. Prune on merge, or when the lane is abandoned.
- **Brief shape for a fixer.** Issue/PR number and head; the checked-out
  branch; the exact findings with file:line, the reviewer's probe to reproduce
  FIRST, and the remedy shape the maintainer chose; what to fold (net-count)
  and what stays out; the suites to run (named files + the mechanical
  governance selector + every tests/config file); the observability record to
  name; "no agents, foreground runs, one CI read, no monitors". Brief a
  reviewer with the PR number, the claims as the fixer stated them, and the
  attack angles that matter for THIS diff; ask for a verdict first.
- **Round routing.** Fix rounds that only apply a reviewer-prescribed remedy
  with quoted reds merge on green (CI read on the exact head, both required
  checks, mergeable state). Rounds that add mechanism, touch session or
  lifecycle semantics, or rewrite a guard get a fresh verify. A verify that
  reports a NEW defect triggers the round-count rail above.
- **Maintainer trailing commits** are for intent-free deltas only (a literal
  NUL byte, a false comment, a missing PR-body heading); anything that changes
  what code MEANS goes through a fix round.
- **Refill order** when the quota gate is open: p1 first, then the queued
  follow-ups in ledger order, then the program work (#2421 → #2416 → #2383/#195).

## Honesty rules

- A finding is real when a probe proves it; a fix is real when the same probe
  passes and the regression test was red first.
- `closes` vs `refs` follows delivery, not optimism; leftovers get an issue
  comment before anything closes.
- After merging a `refs #N` PR, VERIFY the issue: read `gh issue view N
  --comments` and confirm a comment names the remainder. If the PR in fact
  satisfied every acceptance criterion, close N crediting the PR; if a
  remainder exists but is unnamed, post it. A `refs` PR with no remainder
  comment is how #1968 and #2355 sat open for weeks after their fixes
  landed (found 2026-09-02).
- Report what ran, what was skipped, and what CI must still confirm.
