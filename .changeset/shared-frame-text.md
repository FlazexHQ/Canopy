---
"@canopy/realtime": patch
---

Encode a change once for every connection of a shared query: sessions reuse the encoded text of `added`,
`changed` and `removed` (adding only their subscription id and sequence number), share the document in
their merge box, and keep the shared text in the resume buffer. Frames are byte for byte the same.
