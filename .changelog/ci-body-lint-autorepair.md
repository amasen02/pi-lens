---
section: Fixed
---

- Auto-repair clearly flattened pull request bodies before advisory lint validation. Repair only splits inline headings; bodies containing backticks refuse repair and preserve the original lint errors.
