---
"@canopy/realtime": minor
---

`canopy-gateway` writes every frame a WebSocket connection has queued with one `write` to the socket instead of
one per frame. The new `CANOPY_GATEWAY_COALESCE_MS` (or `realtime.coalesceMs` in the gateway's configuration,
0 to 1000, off by default) also holds the frames that follow a write for that window, or until 64 KiB are
queued, so they share the next write and, for clients that negotiated batching, one `batch` frame. A frame that
finds the connection idle still goes out at once.
