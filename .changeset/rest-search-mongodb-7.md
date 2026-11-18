---
"@canopy/rest": patch
---

A `$search`, `$searchMeta` or `$vectorSearch` stage on MongoDB 7.0 without Atlas now answers `503 CANOPY_UNAVAILABLE` like on MongoDB 8.0, instead of a `500`.
