---
"@canopy/realtime": patch
---

A subscription whose snapshot was still loading could miss a delete, or an update that moved a document out of its query, and then keep showing that document until it changed again. Observers now receive every event of their collection while they read a snapshot and replay the ones newer than it.
