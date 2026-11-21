---
"@canopy/matcher": patch
---

Sort keys now follow MongoDB's key generator. A positional path such as `a.0.b` is read inside the array
that the other keys expand, so sorts like `{ "a.b": 1, "a.0.b": 1 }` that MongoDB accepts are no longer
refused as parallel arrays, and numeric field names inside an array addressed by position are refused with
MongoDB's "Ambiguous field name" error. Projections that name both `_id` and a path under it, such as
`{ _id: 1, "_id.x": 1 }`, are refused as a path collision, as MongoDB refuses them.
