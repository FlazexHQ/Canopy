---
"@canopy/rest": minor
---

Evaluate `check(insert)` for a single insert in MongoDB before writing, through a `$documents` aggregation, instead of inserting inside a transaction and reading the document back. A single insert now runs without a transaction, and a document that fails its check is refused before anything is written. Inserts of several documents keep checking after the write inside their transaction, because sending a whole batch a second time costs more than reading it back. Inserted documents are sent with `_id` first, the way MongoDB stores them. A single document larger than 8 MiB, which could not be sent a second time within MongoDB's command size limit, is still checked after the write inside a transaction. `$documents` needs MongoDB 6.0 or later.
