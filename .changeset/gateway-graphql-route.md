---
"@canopy/realtime": minor
"@canopy/server": patch
---

`canopy-gateway` can answer the GraphQL endpoint (`/graphql/v1`) itself, in Rust: select it with `graphql` in
`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`). It serves `GET` and `POST`, batches, persisted operations,
the operation limits, introspection rules and CORS as the TypeScript handler does, and subscriptions
(`live<Plural>` and `<singular>Changes`) over `graphql-transport-ws` and over server sent events, following
live queries through the gateway's own realtime engine with the caller's credentials. The launcher passes the
`graphql` settings, and `readPersistedGraphqlOperations` reads a persisted operations file for it.
