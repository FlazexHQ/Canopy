---
"@canopy/config": minor
"@canopy/realtime": minor
"@canopy/server": minor
---

`realtime.server` (`CANOPY_REALTIME_SERVER`) chooses who serves realtime: `ts`, the engine in the TypeScript
process, or `gateway`, the native `canopy-gateway`. With `gateway`, `canopy-server` starts the gateway on the
public port as the front door: it serves `/realtime/v1` and passes every other request, WebSocket upgrades
included, to the TypeScript server on loopback, which trusts its `X-Forwarded-For`. Socket writes are forwarded
to the server's REST write path, and built in auth tokens are verified against the server's own JWKS.
`startGateway` and `amendConfig` are new exports, and the gateway reports its bound port to its launcher.
