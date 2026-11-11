---
"@canopy/rest": patch
---

An `insertMany` that returns no documents (`Prefer: return=minimal`) evaluates its `check` with one count
of the failing documents instead of an aggregation that would also carry them.
