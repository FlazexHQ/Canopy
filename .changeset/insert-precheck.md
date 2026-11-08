---
"@canopy/rest": minor
---

Evaluate `check(insert)` in MongoDB before writing, through a `$documents` aggregation, instead of inserting inside a transaction and reading the documents back. A single insert now runs without a transaction and a document that fails its check is refused before anything is written; an insert of several documents keeps its transaction so it stays all or nothing, but no longer reads them back. Inserted documents are sent with `_id` first, the way MongoDB stores them. Inserts larger than 8 MiB, which could not be sent a second time within MongoDB's command size limit, are still checked after the write inside a transaction. `$documents` needs MongoDB 6.0 or later.
