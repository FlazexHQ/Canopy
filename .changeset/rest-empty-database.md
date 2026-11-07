---
"@canopy/rest": patch
---

Reads of a collection in a database that does not exist yet no longer fail with `500` ("The read has no
cluster time"). The handler takes a cluster time first and reads again, so the empty result carries a cluster
time it is correct for, and later writes are not missed by clients that reconcile with it.
