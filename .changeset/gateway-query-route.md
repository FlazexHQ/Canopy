---
"@canopy/realtime": minor
---

`canopy-gateway` can also answer `POST /rest/v1/{collection}/_query` (a find with its filter, sort, fields,
limit, skip, cursor and count in a JSON or EJSON body) itself, in Rust: select it with `query` in
`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). It answers as the TypeScript handler does, with the same
policies, page limits and cursors as `find`.
