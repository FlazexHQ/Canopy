---
"@canopy/realtime": patch
"@canopy/rest": patch
---

Snapshot reads no longer fall back to the session's operation time when the driver reports no snapshot
time. The operation time can be later than the snapshot, so change events in between would have been
treated as already delivered and dropped. Without a snapshot time (a collection that does not exist yet),
the reader now takes a cluster time first and reads again, so the reported time is never later than the
result.
