---
"@canopy/rest": patch
---

A batch that is not atomic sends consecutive single document inserts, updates by `_id` and replaces on different documents as one ordered `bulkWrite` on MongoDB 8.0 or later, with their checks in one aggregation and their read backs in one `find` (a batch of an insert, three updates and a replace takes 4 commands instead of 11). Results, errors and stored documents are the same as running each operation alone; a write that MongoDB refuses is sent again alone, and only the `ct` of a grouped operation differs, being the cluster time of the command. `WritePath.executeEach` runs such a batch, and the `groupBatches` option turns the grouping off. A read back after an atomic batch now also finds a document stored with another numeric `_id` type than the one written.
