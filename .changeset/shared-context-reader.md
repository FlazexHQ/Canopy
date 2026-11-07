---
"@canopy/policy": minor
"@canopy/rest": patch
"@canopy/realtime": minor
---

`driverContextReader(db, BSON)` in `@canopy/policy` reads context lookups through a MongoDB driver `Db`; `@canopy/rest`'s `mongoContextReader` and the realtime engine use it. `@canopy/realtime` no longer exports its own copy of `mongoContextReader`; import it from `@canopy/rest`.
