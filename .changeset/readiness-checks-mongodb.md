---
"@canopy/realtime": minor
"@canopy/server": patch
---

`/readyz` of `canopy-server` and `canopy-realtime` now answers `503` with the reason while MongoDB does not answer a ping within 2 seconds or the change stream is not open, so a load balancer stops routing to an instance that cannot serve. The result is cached for a second. `/healthz` stays a static liveness check. `@canopy/realtime` exports `readinessCheck` and `Realtime.changeStreamOpen` for apps that serve their own probes.
