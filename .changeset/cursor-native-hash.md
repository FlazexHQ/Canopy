---
"@canopy/rest": patch
---

Spend less CPU on cursor pages: the cursor hash uses the runtime's native SHA-256 (the same value as
before, so existing cursors stay valid), and the keyset filter built from a decoded cursor is no longer
parsed again.
