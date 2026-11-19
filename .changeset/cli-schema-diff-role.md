---
"@canopy/cli": minor
---

`canopy schema diff --role <role>` also reports, per declared collection, the fields that role cannot read
and the fields it cannot write on insert under the policies' field rules, and collections it cannot read at
all. The report never changes the exit code, which stays 1 only on drift.
