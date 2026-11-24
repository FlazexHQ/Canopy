---
"@canopy/realtime": minor
---

`canopy-gateway` can answer `GET /rest/v1/{collection}/{id}` itself, in Rust: select it with `document` in
`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). It reads the document through the same read policy, field
rules and `fields` projection as the TypeScript handler, in a snapshot whose cluster time is in the body.
