---
"@canopy/rest": patch
---

A replayed realtime mutation (a keyed atomic batch of one operation) that matched or changed nothing now reports
that outcome, instead of the one its idempotency record was first written with.
