---
"@canopy/protocol": patch
"@canopy/rest": patch
"@canopy/realtime": patch
---

Recognize MongoDB server error codes that the driver decodes as an `Int32`, which happens on every read and change stream that asks for exact BSON types. A read that ran out of time was reported as `CANOPY_INTERNAL` instead of `CANOPY_TIMEOUT`, and duplicate key, validation and rejected query errors on that path could be misreported the same way; the change stream ingestor now also recognizes lost history by its code. `@canopy/protocol` exports the `serverErrorCode` helper used for this.
