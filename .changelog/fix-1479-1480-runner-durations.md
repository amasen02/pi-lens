---
section: Fixed
---

- **Test-run durations are reported honestly (closes [#1479](https://github.com/apmantza/pi-lens/issues/1479), closes [#1480](https://github.com/apmantza/pi-lens/issues/1480))** — The turn-end log printed `(0ms)` for a run that was never timed, so an absent measurement was indistinguishable from a sub-millisecond one; it now prints `(unmeasured)`. Behind it, the generic runner parser read an elapsed time only for go and hardcoded `0` for the rest. Cargo, dotnet/vstest, maven/surefire, rspec, and minitest durations are now parsed from the summary block each runner already prints. Gradle stays unmeasured on purpose: its console output carries no test elapsed time, and the build time is not the same number. Multi-class maven runs are also scored by the surefire aggregate rather than by their first test class.
