---
"@canopy/graphql": minor
"@canopy/config": minor
"@canopy/server": minor
---

Add `@canopy/graphql`, the GraphQL API at `/graphql/v1`. The schema is generated per role set from the policies and collection schemas (only readable fields, only granted operations) and cached by policy version, schema version and roles, so it changes atomically when either changes. Collections get a type (`todos` becomes `Todo`), a connection query with typed filters, sorts and cursors, a query by `_id`, a count, and the insert, update, replace and delete mutations their policies grant. Custom scalars are `ObjectId`, `DateTime`, `Long`, `Decimal`, `Binary` and `JSON` (Extended JSON). Reads and writes go through the Data API's read and write paths, so DLS, `check` clauses and `Idempotency-Key` behave as over REST.

Relations are declared per collection in config (`collections.todos.relations.owner = { to: "users", local: "ownerId" }`) and resolved with one `$in` find per relation per tick under the target collection's policies. Subscriptions (`liveTodos` with full results and `todoChanges` with added, changed, removed and ready deltas) follow the realtime engine's observers over SSE, and over graphql-ws on Node servers (`canopy.attach`). Limits: depth 10, a cost budget of 5,000 (every field costs 1 times the `limit` of each list above it), 30 aliases and 10 operations per batch; introspection is closed to `anon` in production by default, and an optional persisted operations file can be the only allowed operations. Errors carry `extensions.code` with the `CANOPY_*` codes. The new `graphql` config section sets the limits, and `collections.<name>.typeName` renames a type. The request log has a `graphql` surface.
