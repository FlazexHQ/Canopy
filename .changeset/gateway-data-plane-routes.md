---
"@canopy/realtime": minor
---

`canopy-gateway` can answer `GET /rest/v1/{collection}` (the Data API `find` route) itself, in Rust, instead of
passing it to the TypeScript server. It is off by default: set `CANOPY_DATA_PLANE_ROUTES=find`, or
`dataPlane.routes` in the gateway's configuration (`GatewayOverrides.dataPlaneRoutes` from the launcher). Every
other request still goes to the TypeScript server unchanged, and a route name the gateway does not know stops it
at startup. The launcher now also passes `rest.defaultLimit` and `rest.maxLimit` (or `rest: false`) so the route
pages as the server does.
