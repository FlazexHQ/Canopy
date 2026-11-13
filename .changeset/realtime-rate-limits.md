---
"@canopy/realtime": minor
---

Rate limit realtime frames and anonymous connections. `createRealtime({ rateLimits })` takes the shared
`RateLimits` of `@canopy/auth`: a `sub`, `mut` or `auth` frame over the caller's budget is answered with
`CANOPY_RATE_LIMITED` in its own reply (`nosub`, a failed `ack` or an `err` frame) and the connection stays
open, and anonymous connections are capped per client address (the extra one closes with `4029`). `connect()`
takes the client address from the transports, `Realtime.clientAddress()` resolves it through trusted proxies,
and `canopy_realtime_rate_limited_total` counts the refusals. The connection limit close code is now sent for
the per subject cap with its `err` frame as well. The `canopy-realtime` sidecar reads the `rateLimits` config.
