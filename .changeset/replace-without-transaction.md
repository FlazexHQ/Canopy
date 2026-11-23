---
"@canopy/rest": patch
---

A single replace without a mutation ID or `upsert` checks the replacement in MongoDB before writing it, through `$documents`, and runs as one `replaceOne` with no transaction (2 commands instead of 3). A replacement that fails its check still runs the transaction, which decides as before. The check runs as an aggregation on the target collection (an empty `_id` match, then `$unionWith` over `$documents`), so strings compare with the collection's default collation; this also stops a single insert from storing a document that a collation makes fail its `check`, which the previous `$documents` aggregation on the database allowed. Replaces whose `check` reads `$$NOW` are checked after the write in a transaction.
