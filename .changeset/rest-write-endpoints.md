---
"@canopy/rest": minor
---

Add the REST write endpoints: `POST /{coll}` (one document or an array), `PATCH /{coll}/{id}` with
update operators or `application/merge-patch+json`, `PUT /{coll}/{id}` with `?upsert=true`,
`DELETE /{coll}/{id}`, bulk `PATCH` and `DELETE /{coll}?filter=…` behind `Prefer: bulk=true`, and
`POST /_batch`. Atomic batches run every operation in one transaction through the new
`WritePath.executeBatch`, abort on the first failure and report its index. `Idempotency-Key` makes a retry
replay the stored result, `?where=` is a compare and set precondition, and `Prefer: return=minimal`
answers `204` with the commit time in `x-canopy-ct`. `insertMany` now returns the readable post images.
