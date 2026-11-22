---
"@canopy/storage": minor
"@canopy/server": minor
"@canopy/config": minor
"@canopy/policy": minor
"@canopy/rest": minor
---

File storage: the `storage` config section serves buckets at `/storage/v1` on GridFS or any S3 compatible store, with DLS policies on the reserved collection `storage.objects` applied to every file's metadata, signed URLs, public buckets, byte ranges and resumable uploads. The client SDK gets `client.storage.from(bucket)`, and the Data API exports `requestCaller` for other handlers.
