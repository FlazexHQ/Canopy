---
"@canopy/realtime": patch
---

Shutdown now drains over the whole window: each connection is closed when the `retryAfterMs` it was sent has passed, instead of every connection being closed after at most one second, so reconnects spread over the configured `drainWindow`. `close()` returns as soon as every client has left.
