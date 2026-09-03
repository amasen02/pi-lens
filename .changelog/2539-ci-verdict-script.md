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
  [--wait <seconds>]` resolves the head SHA, does ONE
  `gh api repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100`, prints a
  fixed CHECK/STATUS/CONCLUSION/URL table for `Unit tests` and
  `Lint & type-check`, and exits `0` only when both concluded `success`,
  `2` when either is absent (DIRTY PR — a merge-conflicted PR can't build its
  merge-ref, so the real gates are skipped, not failed, AGENTS.md recurring-
  defect shape 11), `1` on a completed non-success conclusion, `3` while
  pending. `--wait <seconds>` polls at a fixed, non-configurable >=30s
  interval, clamped to a 20-minute hard cap regardless of the requested
  value, for the orchestrator only. No dependency beyond `gh` on PATH: the
  verdict logic (`computeVerdict`) is a pure function over the check-runs
  JSON, exported and unit-tested against mocked payloads covering all four
  exit codes including the absent-check DIRTY case and a rerun-deduplication
  case (picks the most recently started run when a check name appears twice);
  the `gh` invocation is a thin, injectable shell around it. The fixer
  (`.claude/agents/pi-lens-fixer.md` step 8 and the "CI: read once" bullet)
  and reviewer (`.claude/agents/pi-lens-reviewer.md` step 6 and "CI executed,
  not merely absent") playbooks now reference this script instead of
  hand-written `gh api`/`gh pr checks` invocations.
