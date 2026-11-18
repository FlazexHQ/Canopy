---
"@canopy/realtime": patch
---

After a snapshot fails (for example during a brief MongoDB outage), the next subscription to the same query builds a new observer instead of being refused with the same error until the observer's 30 second linger ran out.
