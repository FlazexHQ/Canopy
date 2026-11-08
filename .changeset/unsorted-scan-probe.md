---
"@canopy/rest": minor
---

Speed up finds without a sort whose filter no index covers. Such a find is ordered by `_id` so its cursor is stable, and MongoDB serves that order by walking the whole `_id` index and fetching every document, which took about 2.8 times as long as a collection scan when few documents matched (888 against 317 ms on 1 million documents) and made such reads time out from about 1 million documents. A find without a sort now walks `_id` order for as long as a scan of the whole collection is estimated to take (at least `unsortedProbeMS`, 100 ms by default, and at most half of `maxTimeMS`; the estimate comes from the collection's metadata and `scanMSPerMillion`, 400 ms by default) and, if that runs out, reads again in the same snapshot as a collection scan with an in memory sort, within the same `maxTimeMS`. Such a find so costs about twice the faster plan at most. `unsortedProbeMS: 0` turns the switch off. Results, order and cursors are unchanged.
