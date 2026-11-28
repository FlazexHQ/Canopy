---
"@canopy/realtime": minor
---

`dataPlane.routes` (and `CANOPY_DATA_PLANE_ROUTES`) accepts `all`, which selects every Data API route, plus
`graphql` and `storage` when they are configured, so a deployment can hand every data route to the gateway
without listing them.
