---
section: Added
---

- **`scripts/ci-verdict.mjs`: one REST read of Unit tests + Lint & type-check conclusions on an exact head SHA (closes #2539)** —
  three failure modes in one day came from how humans and agents read CI: the tail of `gh pr checks`
  hid a failed Unit tests behind a passing Lint (#2527 review round 2 merge
  blocked), a fixer fabricated a CI quote from local numbers instead of
  quoting a real run, and 12 agents polling `gh pr checks --watch` in one day
  exhausted the 5000/hr GitHub API budget (a CodeQL 429 on master). Sibling to
  `scripts/check-pr-body.mjs`: `node scripts/ci-verdict.mjs <pr-number|sha>
  [--wait <seconds>]` resolves the head SHA (and, for a PR number, the
  `mergeable` state via the same `gh pr view` call), does ONE
  `gh api repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100`, prints a
  fixed CHECK/STATUS/CONCLUSION/URL table for `Unit tests` and
  `Lint & type-check`, and exits `0` only when both concluded `success`,
  `2` when either is absent AND the PR is confirmed merge-conflicted
  (`mergeable === "CONFLICTING"` — a merge-conflicted PR can't build its
  merge-ref, so the real gates are skipped, not failed, AGENTS.md recurring-
  defect shape 11), `1` on a completed non-success conclusion, `3` while
  pending (which now also covers an absent check that is NOT confirmed
  merge-conflicted — CI simply hasn't registered yet, the common case on a
  fresh push — and a check-runs response GitHub reports as truncated via its
  own `total_count`), `64` on a usage error, `70` on a transport/unexpected
  error (distinct sysexits-style codes so neither collides with a verdict
  code). `--wait <seconds>` polls at a fixed, non-configurable >=30s
  interval, clamped to a 20-minute hard cap regardless of the requested
  value, for the orchestrator only; every `gh` call carries an explicit
  timeout derived from the remaining `--wait` budget (or a flat 60s default).
  No dependency beyond `gh` on PATH: the verdict logic (`computeVerdict`) is
  a pure function over the check-runs JSON, exported and unit-tested against
  mocked payloads covering every exit code including the mergeable-aware
  absent-check cases and a fail-closed rerun-deduplication case (shared with
  `scripts/lib/merge-train-warden.mjs` and `scripts/lib/merge-train-lane.mjs`
  via the new `scripts/lib/ci-checks.mjs`, replacing three separately
  maintained copies of the required-checks list and tie policy with one);
  the `gh` invocation is a thin, injectable shell around it. The fixer
  (`.claude/agents/pi-lens-fixer.md` step 8 and the "CI: read once" bullet)
  and reviewer (`.claude/agents/pi-lens-reviewer.md` step 6 and "CI executed,
  not merely absent") playbooks now reference this script instead of
  hand-written `gh api`/`gh pr checks` invocations.
