---
"@canopy/client": minor
---

`createClient({ url, publishableKey, schema })` takes the schema from `canopy.schema.ts`. Inserts fill in the
schema's defaults and generate the `_id` its builder declares before the optimistic apply, so the type of
`insert(...).id` always matches the runtime value; a collection whose `_id` the caller supplies throws before
anything is queued. Augmenting the new `Register` interface types the client, `CanopyClient` and the helpers
`Doc<"todos">`, `Id<"todos">`, `NewDoc<"todos">` and `Patch<"todos">` with no generic parameter, and makes the
`schema` option required. Untyped clients, `idTypes`, `createClient<Database>()` and `DocumentSchema` keep
working.
