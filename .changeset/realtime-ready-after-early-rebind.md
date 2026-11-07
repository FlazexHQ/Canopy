---
"@canopy/realtime": patch
---

A subscription that moved to a new observer before its first snapshot was complete (for example when a
cached context lookup was refreshed right after `sub`) never got `ready`: the move swallowed it. The client
now always gets one `ready`, after the `removed` messages of the move.
