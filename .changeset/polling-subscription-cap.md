---
"@canopy/realtime": patch
---

Subscriptions that fall back to polling (filters the in process matcher cannot run, such as a regular expression with a backreference) are now capped at `maxTrackedDocs` like the other subscriptions: without a `limit`, one that matches more documents fails with `CANOPY_SUBSCRIPTION_TOO_LARGE` instead of re-reading the whole match on every poll.
