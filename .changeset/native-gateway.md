---
"@canopy/realtime": minor
---

Run `canopy-realtime` on the native gateway with `CANOPY_REALTIME_SERVER=gateway`. The sidecar resolves its
configuration and policies as before (policy files included, passed in stored form), then starts the Rust
`canopy-gateway` with them on standard input, sends it reloaded policies, and drains it on shutdown. The
gateway speaks the same `canopy.v1`, so clients need no change. It is found through `CANOPY_GATEWAY_BIN` or a
Cargo build of the repository; writes over the socket are forwarded to the REST write path given by
`CANOPY_GATEWAY_MUTATIONS_URL`, and are refused without it, as on the TypeScript sidecar.
