---
"@canopy/auth": minor
"@canopy/config": minor
---

Add the data plane rate limiter. `@canopy/auth` exports `RateLimits` and `TokenBuckets`: token buckets per
caller (API key plus subject, and the client address for anonymous callers) for REST and GraphQL requests and
for realtime frames, a cap on anonymous realtime connections per address, and an exemption for the `service`
role. `@canopy/config` adds the `rateLimits` section (`CANOPY_RATE_LIMITS` and the `CANOPY_RATE_LIMIT_*`
variables) with defaults ordinary apps do not reach; `rateLimits: false` turns every limit off.
