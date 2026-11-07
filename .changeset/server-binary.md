---
"@canopy/server": minor
---

Add the `canopy-server` binary, the all in one Canopy process. It loads the config with `--config` or by
discovery plus the well known variables, serves REST, realtime (WebSocket, SSE and long polling), `/healthz`
and `/readyz` on `PORT` with `Bun.serve` on Bun and `node:http` on Node, writes JSON logs, serves Prometheus
metrics on `METRICS_PORT`, prints every config problem and exits 1 when the config is invalid, and drains on
SIGTERM or SIGINT: readiness fails, sockets are told to reconnect within the drain window, then the process
exits 0.
