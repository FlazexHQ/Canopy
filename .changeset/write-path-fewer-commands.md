---
"@canopy/rest": minor
"@canopy/realtime": minor
---

Send fewer commands per write. A fast path write reads its document back outside its causally consistent
session, so the read no longer waits for the cluster time (a full timer tick on Windows). A single document
is read back with `find` instead of a `$facet` aggregation, and an update whose `check` is implied skips the
check evaluation. The new `WriteOptions.returnDocuments: false` skips the read back altogether (`check` is
still evaluated by MongoDB); REST passes it for `Prefer: return=minimal`, and realtime mutations on watched
collections pass it and read the documents only when the echo does not arrive (`MutationExecutor.documentsOf`).
On MongoDB 8.0 and later, a keyed single document update or insert sends the write and its idempotency
record as one `bulkWrite` command. Idempotency records no longer store documents: a replay reads the
current readable documents again, and a replayed delete returns `null` in place of its pre image.
