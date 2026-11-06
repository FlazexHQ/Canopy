---
"@canopy/protocol": minor
"@canopy/realtime": patch
---

Add `toBsonLibrary` to `@canopy/protocol`, which turns decoded EJSON values into instances of a full BSON
library such as the one the MongoDB driver exports. Realtime uses it for snapshots, so live queries whose
filters hold values such as `$oid` or `$numberLong` no longer fail.
