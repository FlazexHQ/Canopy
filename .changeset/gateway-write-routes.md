---
"@canopy/realtime": minor
---

`canopy-gateway` can answer the Data API writes itself, in Rust: select them with `writes` in
`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). Inserts, updates (operators or a merge patch), replacements
with upsert, deletes, bulk writes and `_batch` run in the gateway's own transactions with the same policies,
checks, field rules, idempotency records and responses as the TypeScript handler. The launcher now also passes
`rest.idTypes`, `rest.mutationTtlSeconds`, `rest.explainDenials` and `audit.dataWrites` to the gateway.
