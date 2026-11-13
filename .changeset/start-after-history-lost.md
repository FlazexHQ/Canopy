---
"@canopy/realtime": patch
---

The realtime engine now starts when its stored change stream position is older than the oplog (after downtime longer than the oplog window): it restarts the stream from now, counts a `history_lost` restart and logs it, as it already did when this happened while running. Before, startup failed until the checkpoint was deleted by hand.
