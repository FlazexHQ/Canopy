---
"@canopy/realtime": patch
---

The periodic checkpoint no longer runs while a batch of change events is being delivered. It could report the stream as past events subscribers had not received yet, so a mutation's ack could claim its echo before the change was sent, and the saved stream position could skip those events after a crash. Checkpoints now lag by up to one batch.
