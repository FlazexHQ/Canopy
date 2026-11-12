---
"@canopy/graphql": minor
"@canopy/server": minor
---

Add the GraphQL explorer to Studio (API, GraphQL) and `POST /admin/v1/graphql` behind it. The explorer completes and validates operations against the schema of the chosen caller, lists the root fields and inserts a starter operation for each, and runs operations as `service` or as an impersonated role or user. Impersonated callers run read only; mutations also need the `documents.write` permission and are refused in production. Impersonation and every mutation are audited (`graphql.viewAs`, `graphql.mutation`). `GraphqlHandler.run` runs an operation for a caller that is already authenticated.
