---
"@canopy/rest": patch
---

Encode a `GET` page once: its ETag is the native SHA-256 of the encoded response text instead of a second,
canonical encoding hashed in JavaScript. ETags change once after the upgrade, so a poller's next
conditional request gets a full `200` before `304`s resume.
