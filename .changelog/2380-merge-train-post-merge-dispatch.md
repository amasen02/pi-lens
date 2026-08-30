---
section: Fixed
---

- **Replay exact-SHA master validation after merge-train merges (closes #2380)** — merge-lane merges authenticated with `GITHUB_TOKEN` no longer lose the ordinary push-triggered validation. The lane dispatches a `merge-train-post-merge` event with the merge response's exact SHA and repository, while CI, lint, install-smoke, and label-sync workflows check out that SHA. Per-workflow SHA concurrency prevents duplicate events from validating the same commit concurrently. Missing merge identity and dispatch failures stay visible as landed-but-unverified errors.
