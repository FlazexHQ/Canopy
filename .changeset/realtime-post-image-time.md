---
"@canopy/native": patch
"@canopy/protocol": patch
"@canopy/realtime": patch
"@canopy/wasm": patch
---

Read missing realtime post images at the change event's cluster time. Bound heartbeat and reconnect timers in the client. Keep old BSON binary values stable on round trip, reject duplicate field names consistently across both Rust BSON readers, and encode own EJSON properties without changing the output prototype.
