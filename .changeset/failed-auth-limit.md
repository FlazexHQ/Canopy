---
"@canopy/auth": minor
"@canopy/config": minor
"@canopy/rest": minor
"@canopy/graphql": minor
"@canopy/realtime": minor
"@canopy/server": minor
---

Count failed authentications per client address. An address that keeps sending unknown API keys or tokens that do not verify is refused with `CANOPY_RATE_LIMITED` before its credentials are checked, on REST, GraphQL and the realtime handshake. Configure it with `rateLimits.failedAuthentications` (default 1 per second, burst 30).
