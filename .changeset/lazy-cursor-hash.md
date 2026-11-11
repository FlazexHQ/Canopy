---
"@canopy/rest": patch
---

A find computes the hash that ties a cursor to its query only when it reads a cursor or returns one, so the last page of a query and finds that fit on one page skip the SHA-256.
