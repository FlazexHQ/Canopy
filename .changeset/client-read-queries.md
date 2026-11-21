---
"@canopy/client": minor
"@canopy/react": minor
"@canopy/vue": patch
"@canopy/svelte": patch
"@canopy/solid": patch
"@canopy/tanstack-db": patch
---

`client.from("todos")` is now typed as a `Collection`: it owns the writes, and `find`, `sort`, `fields` and
`limit` return a read only `Query`, so a filtered query can no longer widen a write by accident. Calling a
write method on a derived query still works for this release but is deprecated and warns once: it always
ignored the query and wrote by its own filter or ID. The same literal projection now narrows the documents
of `client.live()`, `db.todos.useQuery()` and `createServerClient().find()` (its `Snapshot<T>` is generic),
a projection that mixes inclusion and exclusion no longer compiles, and a projection known only at runtime
gives deep partial documents. React collection inserts return `MutationHandle<Id>`. The framework bindings
default to the registered schema. `live<C, Out>()` no longer takes an output type argument: cast the
query instead.
