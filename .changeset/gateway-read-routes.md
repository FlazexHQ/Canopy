---
"@canopy/realtime": minor
---

`canopy-gateway` can also answer `POST /rest/v1/{collection}/_count`, `_distinct` and `_aggregate` itself, in
Rust: select them with `count`, `distinct` and `aggregate` in `CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`,
`GatewayOverrides.dataPlaneRoutes` from the launcher), alone or with `find`. They answer as the TypeScript
handler does, with the same pipeline sanitizer and policy prefix. The launcher now also passes `rest.maxBodyBytes`
and the collections with `search: true` (as `rest.search`), so the routes take the same bodies and allow
`$search` on the same collections.
