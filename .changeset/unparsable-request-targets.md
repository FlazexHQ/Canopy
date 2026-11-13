---
"@canopy/node-http": patch
"@canopy/server": patch
"@canopy/realtime": patch
"@canopy/graphql": patch
---

A request whose target does not parse as a URL (such as `GET //`) now gets `400 Bad request`, and a WebSocket upgrade with such a target is closed, instead of throwing in the listener and ending the Node process. `requestUrl` is replaced by `tryRequestUrl`, which also ignores a `Host` header that does not parse, and `tryPathname` is added.
