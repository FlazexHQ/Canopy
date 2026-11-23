---
"@canopy/rest": patch
---

On MongoDB 7.0, a search request and the search capability probe now report that MongoDB Search is not available (503 `CANOPY_UNAVAILABLE`, and `available: false` in diagnostics) instead of failing with an internal error: MongoDB 7.0 refuses `$search` and `$listSearchIndexes` outside Atlas with code 6047401, which was not recognized.
