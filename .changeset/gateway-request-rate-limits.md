---
"@canopy/realtime": minor
---

The Data API routes `canopy-gateway` serves itself apply the request rate limits of the TypeScript handler:
`rateLimits.requests` per caller and `rateLimits.failedAuthentications` per client address, answering `429` with
`Retry-After`, and count refusals in `canopy_http_rate_limited_total{surface="rest"}`. The launcher now passes both
settings to the gateway. The gateway counts on its own, so a caller has one budget there and one on the server.
