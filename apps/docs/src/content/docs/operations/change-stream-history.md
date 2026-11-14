---
title: Change stream history loss
description: What happens when the oplog no longer holds the realtime engine's position, and how to prevent it.
---

The realtime engine follows one change stream per instance and remembers its position (a resume token). If an
instance is down, or falls behind, for longer than the oplog covers, MongoDB can no longer resume from that
position: the history is lost.

## What Canopy does

The engine recognizes the error (`ChangeStreamHistoryLost`, or a resume token MongoDB no longer accepts), opens
a new change stream from the current time and sends `resync` to every subscription. Clients take a fresh
snapshot of each live query. No change is delivered out of order and nothing is dropped silently, but every
client pays for a snapshot at once, which is a burst of reads.

You see it as:

- `canopy_changestream_restarts_total{reason="history_lost"}` going up on the metrics port,
- an `error` log line `change stream history lost, restarting from now`,
- a burst of `find` load on the app database right after.

## Preventing it

- **Size the oplog for your longest outage.** On Atlas set a minimum oplog window; on your own servers use
  `replSetResizeOplog` and keep `oplogMinRetentionHours` above the longest time an instance may be down or
  behind (a day is a sensible floor). `rs.printReplicationInfo()` shows the current window.
- **Watch the lag.** Alert when `canopy_changestream_lag_seconds` stays above a few seconds: an instance that
  cannot keep up eventually falls off the oplog.
- **Keep `realtime.checkpoints: "meta"`** (the default): positions are stored in the meta database, so a
  restarted instance resumes where it stopped instead of resyncing everyone, as long as the oplog still covers
  that position.

## After it happened

Nothing needs repairing. If it happens again, raise the oplog window or find what keeps the instance behind
(CPU, a slow MongoDB, very large documents with `fullDocument: "updateLookup"`).
