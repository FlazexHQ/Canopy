---
"@canopy/realtime": minor
---

`canopy-realtime` now reads its settings through `@canopy/config`: a config file given with `--config` or
found as `canopy.config.ts` or `canopy/canopy.config.ts`, plus the same `CANOPY_*` variables as before, which
keep working without a file. Invalid settings are listed together, with fixes, before anything starts.
`realtime.transports` is honored: the SSE and long-poll endpoints, or WebSocket upgrades, can be turned off.
The Docker image links `@canopy/config` so mounted config files can import it.
