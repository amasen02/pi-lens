---
section: Fixed
---

- **Cap the widget footer's dependency-drift re-serves (refs #2275, sibling of #1950)** — A dependency-drift-demoted diagnostic that the pi-lens footer keeps re-serving is now retired after 3 unconfirmed deliveries, instead of re-serving for the rest of the session. Deliveries are counted per footer RENDER (the footer draws one file per pass, so files it never showed are never charged), and retiring HIDES the row from the footer only: it stays in `lens_diagnostics mode=all` and remains addressable by `lens_diagnostic_mark`, with a note saying the footer stopped showing it and a re-run can still confirm it.
