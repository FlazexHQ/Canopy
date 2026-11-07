---
"@canopy/client": minor
"@canopy/react": minor
"@canopy/schema": minor
---

Type the SDK with the generated schema. `createClient<Database>(...)` checks collection names, filters,
sorts, projections, update operators, inserts and `_id` arguments against the `Database` interface that
`canopy gen types` writes; unknown fields and wrong value types no longer compile. Dotted paths are checked to
a depth of 4 with MongoDB's array semantics, and `fields()` narrows the returned row type. Without a type
argument the client stays untyped. `createReactDb(client)` takes its types from the client (or
`createReactDb<Database>(client)` types an untyped one), and `CanopyProvider` and `useCanopy<Database>()`
accept typed clients. Hand written row types work through `RowSchema<{ todos: Todo }>`, whose inserts make
`_id` optional. Breaking: `from<T>()`, `live<T>()` and `createReactDb<{ todos: Todo }>()` no longer take a row
type; use a schema instead. `canopy gen types` now also emits a row alias per collection
(`export type Todos = Database["todos"]["Row"]`).
