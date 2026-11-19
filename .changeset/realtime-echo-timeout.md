---
"@canopy/config": minor
"@canopy/server": minor
"@canopy/realtime": minor
---

A new `realtime.echoTimeout` setting (`CANOPY_ECHO_TIMEOUT`, default `2s`) sets how long a write's
acknowledgement waits for its change events before it is sent with the post images and `echo: false`. The
server and the `canopy-realtime` sidecar pass it to the realtime engine. Raise it on a sharded cluster, where
change events cross mongos and can take longer than 2 seconds on a loaded host.
