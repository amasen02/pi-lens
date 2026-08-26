---
section: Fixed
---

- **Key process-unique state on `globalThis` so it survives a second module evaluation (refs #2146)** — pi evaluates the pi-lens module graph up to nine times per process, so the primary-session registration and the instance-registry mutation tail existed once per evaluation instead of once per process. The concurrent-session guard read an empty registration and ran the full session_start battery per subagent temp root, and concurrent read-modify-write cycles tore `instances.json`. Both now share one versioned process singleton, and `host_boot` records the evaluation ordinal. `session_shutdown` gained the same root discriminator `session_start` has, so a subagent's teardown no longer clears the shared registration and leaves the next subagent to run the full battery.
