---
"@canopy/policy": minor
"@canopy/cli": patch
---

`equalityFields` is exported from `@canopy/policy` and used by both the `missing-index` lint rule and `canopy indexes advise`, so they agree: equality fields inside `$and` count, and `_id` is never reported.
