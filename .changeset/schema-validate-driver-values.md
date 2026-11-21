---
"@canopy/schema": patch
---

A collection definition's Standard Schema validation recognizes BSON values by their type tag instead of
`instanceof`, so documents decoded by the MongoDB driver (its own copy of `bson`) validate: an `ObjectId`,
`Long`, `Decimal128`, `Int32`, `Double` or UUID `Binary` from the driver no longer fails with
"Expected objectId, got a ObjectId".
