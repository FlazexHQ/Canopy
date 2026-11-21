---
"@canopy/schema": minor
---

`diffSchemas(declared, actual)` compares the collections declared in code with the schemas read from the
database and lists each difference (missing or undeclared collections and fields, types, requiredness) with
a readable message. A declared type wider than the stored values is not a difference. `toValidator(shape)`
writes a shape as a MongoDB `$jsonSchema` with `bsonType`, ready for `collMod`.
