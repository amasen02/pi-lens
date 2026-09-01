---
section: Fixed
---

- **Make the #2358 CPU-liveness regression proof clock-boundary safe (refs #2358).**
  The real-runner test now relies on the recorded CPU-flat discriminator and
  armed budget instead of requiring a `Date.now()` sample to equal the timer's
  millisecond deadline. Node can report one millisecond less when its timer and
  wall-clock reads straddle a boundary.
