---
"@canopy/rest": minor
"@canopy/graphql": minor
"@canopy/server": minor
---

Rate limit the Data API and GraphQL per caller. `createRestHandler` and `createGraphqlHandler` take
`rateLimits` and answer `429` with `Retry-After` and `CANOPY_RATE_LIMITED` (for graphql-ws, the same code in
the operation's errors); `fetch` takes `{ ip }` so anonymous callers are limited per client address, resolved
through `server.trustedProxies`. `canopy-server` configures all three surfaces from the `rateLimits` section,
exempts the `service` role by default, and exports `canopy_http_rate_limited_total` through the new
`Canopy.renderMetrics()`.
