---
"@canopy/schema": minor
---

`emitSchemaFile(schemas)` writes the source of a `canopy.schema.ts` (or, with `js: true`, `canopy.schema.js`)
from collection schemas read from validators, config or sampled documents: one `collection()` per
collection with `t` builders, `defineSchema()` and the `Register` augmentation. The output is deterministic,
and sampled enums and optional fields carry a temporary comment asking for review.
