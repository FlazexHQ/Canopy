---
"@canopy/client": patch
---

`storage.from(bucket).download()` returns a `Blob` typed by the response's `content-type` on Bun too, which leaves the type of a streamed body empty.
