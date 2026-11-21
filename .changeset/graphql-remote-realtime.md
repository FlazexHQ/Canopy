---
"@canopy/graphql": minor
"@canopy/server": minor
---

GraphQL subscriptions work when the native gateway serves realtime. `createGraphqlHandler` takes either the
in-process realtime engine or a `RemoteRealtime` (an HTTP base URL and an optional WebSocket class) and follows
live queries over a WebSocket with the caller's credentials. In gateway mode `canopy-server` points GraphQL at
the gateway on loopback through the new `gatewayUrl` option of `createCanopy`.
