---
"@canopy/rest": minor
---

Speed up finds without a sort whose filter no index covers. Such a find is ordered by `_id` so its cursor is stable, and MongoDB serves that order by walking the whole `_id` index and fetching every document, which took about 2.8 times as long as a collection scan when few documents matched (888 against 317 ms on 1 million documents) and made such reads time out from about 1 million documents. A find without a sort now tries the `_id` walk for `unsortedProbeMS` (a new read limit, 100 ms by default, `0` turns it off) and, if that runs out, reads again in the same snapshot as a collection scan with an in memory sort, within the same `maxTimeMS`. Results, order and cursors are unchanged.
