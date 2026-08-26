---
section: Fixed
---

- Auto-repair clearly flattened pull request bodies before advisory lint validation. Repair only splits inline headings; duplicate or otherwise structurally inconsistent template headings refuse repair and preserve the original lint errors.
