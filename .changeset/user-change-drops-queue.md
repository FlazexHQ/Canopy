---
"@canopy/client": patch
---

When the signed in user changes, mutations queued by the previous user are no longer sent as the new user. Their optimistic changes are removed and their promises reject with `CANOPY_UNAUTHORIZED`; their persisted copies stay and are sent when that user signs in again on the device. The new user's own persisted queue is restored, and the previous user's stale mutations are no longer offered. An anonymous user who upgrades in place keeps the queue.
