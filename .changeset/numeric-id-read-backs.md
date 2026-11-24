---
"@canopy/rest": patch
---

An atomic batch now reads back documents with numeric `_id`s (Int32, Long and Double) with one `find` per
collection at the end of the transaction, as it already did for strings and ObjectIds: numbers are compared by
value across BSON types, as MongoDB compares them. Decimal128 `_id`s are still read back one at a time.
