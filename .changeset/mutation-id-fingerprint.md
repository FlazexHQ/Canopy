---
"@canopy/rest": patch
---

A mutation ID is now bound to the request and the caller's roles that first used it. Reusing it with a different body or role set fails with `CANOPY_CONFLICT` instead of silently returning the first write's stored result. Retries of the same request still replay. Records written before this change (kept for 24 hours) replay as before.
