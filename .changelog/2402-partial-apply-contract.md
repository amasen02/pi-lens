---
section: Fixed
---

- **Recognize already-applied edits instead of re-applying them on retry (closes #2402)** —
  a mixed-validity edit batch could commit its valid subset, then report the
  result with the preflight's oldText-not-found verdict after the post-edit
  analysis failed, so the identical retry re-executed the write against content
  the committed edit had already replaced (the reported session duplicated one
  import line 15 times before the loop burned out). Partial apply now carries
  the preflight's snapshot identity and exact non-overlapping spans instead of
  re-searching oldText against a changed buffer (#1053 substrate): the whole
  batch is validated — snapshot hash, span bounds, span text, pairwise
  non-overlap — before any write, and a rejection commits nothing. The commit
  routes through the shared atomic writer under the file lock. A committed
  write and a failed post-edit analysis are separate outcomes, so the block
  reason leads with the committed indexes and never with a RETRYABLE
  oldText-miss header. Every applied pair — partial-apply commits and
  successful native edits alike — lands in a session-scoped bounded record;
  an identical retry is answered with `✅ ALREADY APPLIED` from that record
  plus content evidence (oldText gone, or every remaining occurrence inside
  its own applied newText), never from a global newText-presence heuristic.
