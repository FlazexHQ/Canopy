---
"@canopy/server": minor
---

Add `@canopy/server` with `createCanopy(config)`, which composes Canopy from a config (resolved, or the
default export of a config file): one MongoDB client (or the application's, which it leaves open), one
authenticator, one policy source with hot reload shared by REST and realtime, one context lookup resolver
whose live invalidations reach REST, and the REST write path as realtime's mutation executor. It serves
through `fetch` (any runtime), `node()` plus `attach(server)` (Node, with streaming SSE), or `bun()`, with
`/healthz` and `/readyz`, honors `rest: false`, `realtime: false` and the configured transports, and closes
in order with `close()` or `await using`. `defineConfig`, `env` and `external` are re-exported.
