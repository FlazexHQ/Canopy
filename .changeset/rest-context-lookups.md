---
"@canopy/rest": minor
---

Enforce context lookups (`$ctx`) in the Data API. After authentication, the handler resolves the lookups
the addressed collection's policies use (every collection's for `_batch` and `_aggregate`) before any policy
is evaluated, so reads, counts, aggregations and the `using` and `check` clauses of writes all see them. A
lookup that fails denies. Pass `contexts` to share the realtime engine's `ContextResolver`, so membership
changes on its change stream reach REST at once; the default resolver reads the app database and its
results expire after the lookup's `ttl`. `mongoContextReader()` is exported for custom resolvers.
