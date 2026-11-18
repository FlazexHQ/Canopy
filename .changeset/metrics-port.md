---
"@canopy/config": minor
"@canopy/node-http": minor
"@canopy/server": minor
"@canopy/realtime": minor
---

The metrics port binds `127.0.0.1` by default (`server.metricsHost`, `METRICS_HOST`; the container images use `0.0.0.0`) and can require a bearer token (`server.metricsToken`, `CANOPY_METRICS_TOKEN`).
