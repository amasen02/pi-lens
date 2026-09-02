---
section: Fixed
---

- **Cap the widget footer's dependency-drift re-serves (refs #2275, sibling of #1950)** — A dependency-drift-demoted diagnostic in the footer widget's own diagnostic store now retires after 3 degraded deliveries with no re-run, instead of re-serving forever. Shares #1950's cap constant and retire-decision helper (`clients/blocker-freshness.ts`); the retirement note says the finding can still be confirmed by a fresh dispatch, same as #1950's inline-blocker cap.
