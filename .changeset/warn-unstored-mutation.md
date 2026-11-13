---
"@canopy/client": patch
---

When the persister cannot store a queued mutation (a full or blocked storage), the client now warns in the console instead of failing silently, since the mutation is lost if the page closes before it is sent.
