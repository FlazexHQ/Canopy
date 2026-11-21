---
"@canopy/query": patch
---

`parseLimit` returns `0` for a limit of `-0`, so a live query with `limit: -0` shares the observer key of the
same query with `limit: 0` instead of hashing to a different key.
