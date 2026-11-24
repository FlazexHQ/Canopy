---
"@canopy/realtime": minor
---

`canopy-gateway` can also answer `POST /rest/v1/{collection}/_explain` itself, in Rust: select it with
`explain` in `CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). It explains how DLS decides an operation for
the caller stated in the body, with the same report, effective filter, text and count as the TypeScript handler,
and only for secret keys.
