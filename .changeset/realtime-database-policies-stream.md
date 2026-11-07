---
"@canopy/realtime": patch
---

Fix hot reload of policies stored in the meta database: the change stream on `canopy.policies` asked for
`fullDocument: "off"`, which MongoDB rejects, so publishes were never picked up. The stream is now reopened
with a full reload after any failure.
