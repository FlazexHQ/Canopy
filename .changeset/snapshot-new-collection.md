---
"@canopy/realtime": patch
---

Never miss the document that creates a collection while a subscription reads its snapshot. A read of a
collection that does not exist yet has no snapshot time, so the realtime server takes a cluster time and reads
again; that second read is now pinned to the cluster time it reports (`readConcern` `snapshot` with
`atClusterTime`), where before a write at or just before that time could be left out of the result and its
change event skipped as already delivered.
