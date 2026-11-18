---
"@canopy/realtime": patch
---

Shutdown now drains over the whole window: each connection is closed when the `retryAfterMs` it was sent has passed, instead of every connection being closed after at most one second, so reconnects spread over the configured `drainWindow`. Sessions that only wait for a resume end at once, and `close()` returns as soon as every client has left. A `close()` with connected clients that ignore `reconnect` can now take up to the drain window, so tests that leave connections open should configure a short `drainWindow`.
