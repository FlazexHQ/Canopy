---
title: Client SDK
description: Live queries, optimistic writes and typed collections with @canopy/client.
---

```bash
bun add @canopy/client
```

<!-- snippet: declare const identityProvider: { getAccessToken(): Promise<string> } -->

```ts
import { createClient } from "@canopy/client"

const canopy = createClient({
  url: "https://api.example.com",
  publishableKey: "pk_app",
  auth: { getToken: () => identityProvider.getAccessToken() },
})
```

`auth` is anything with a `getToken()` method: your identity provider's SDK, or `createAuth()` from
`@canopy/client/auth` for [built in auth](/concepts/auth/). The token is read on every connect and before it
expires.

## Live queries

```ts
const stop = canopy
  .from("todos")
  .find({ done: false })
  .sort({ createdAt: -1 })
  .limit(50)
  .subscribe(({ data, status }) => render(data, status))
```

`status` is `loading`, `ready`, `stale` (cached data shown before the server answered) or `error`. The same
query from two components shares one subscription. `canopy.live("todos", filter, options)` is the same query
without the builder.

`canopy.from("todos")` is the collection: it owns the writes. `find`, `sort`, `fields` and `limit` return a
read only query, so a filter you built for reading can never widen a write by accident; give a bulk write its
own filter. A second `find` replaces the filter instead of combining with it. A literal `fields` projection
narrows the documents' type in `from(...).fields(...)`, `live()`, the React hooks and server snapshots alike.

Filters use MongoDB syntax and run both on the server and in the client's matcher, so optimistic writes show
up in every affected query at once.

## Writes

```ts
const created = canopy.insert("todos", { title: "Write docs", done: false })
const id = created.id // usable at once, before the server answers
await created
await canopy.update("todos", id, { $set: { done: true } })
await canopy.replace("todos", id, { title: "Write more docs", done: false })
await canopy.delete("todos", id)
await canopy.updateMany("todos", { done: true }, { $set: { archived: true } })
```

`created.id` is the new document's `_id`, available at once, before the server answers: use it to render or
to link to the document. `await created` waits for the server's acknowledgement, and rejects if the write was
refused. Each call returns a `MutationHandle`: the change is visible locally at once, and the handle resolves with the
write's cluster time and counts when the server acknowledges it, or rejects with a typed error after the local
change is rolled back. Single document writes take `{ where }`, a compare and set precondition that fails with
`ConflictError`.
`canopy.onMutationError(listener)` reports failures in one place.

## Types

Declare your collections in `canopy.schema.ts` (`bunx canopy pull` writes the first version) and pass the
schema to the client. Queries and writes are checked against it, and inserts take their `_id` generator and
defaults from it. See [Schema in code](/guides/schema/).

```ts
import { createClient } from "@canopy/client"
import { schema } from "./canopy.schema.ts"

const typed = createClient({ url, publishableKey, schema })
// @ts-expect-error done is a boolean
typed.from("todos").find({ done: "yes" })
```

`canopy gen types` and `createClient<Database>()` still work, and are deprecated in favour of the schema
file.

## One-off reads over HTTP

For an export, a filter dropdown or a server job, `@canopy/client/rest` reads through the Data API with the
same identity and policies as a live query, without a WebSocket or a document cache. Building a query sends
nothing; `page()`, `findById()` and `count()` each make one request.

<!-- snippet: declare const signal: AbortSignal -->

```ts
import { createRestClient } from "@canopy/client/rest"
import { schema } from "./canopy.schema.ts"

const rest = createRestClient({ url, publishableKey, auth: { getToken }, schema })
const todos = rest.from("todos")
const open = todos.find({ done: false }).fields({ title: 1 }).sort({ _id: 1 }).limit(20)

const first = await open.page({ signal })
if (first.page.next !== null) {
  const next = await open.page({ after: first.page.next, signal })
  render(next.data)
}
const { data: total } = await todos.count({ done: false }, { signal })
render(total.count, total.exact)
```

A live subscription keeps a result current; a REST page is a snapshot at the cluster time in `ct`.
Errors are the same typed `CanopyError` subclasses, with the server's request ID in `details.requestId`.

## Connection status

`canopy.connectionStatus` is `connecting`, `live`, `fallback` (on SSE or long polling), `reconnecting`,
`offline` or `closed`, and `canopy.onStatus(listener)`
reports changes. Mutations made offline are queued and sent in order on reconnect.

## Options

| Option           | What                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `persist`        | A persister, so pending mutations and the session survive reloads                           |
| `cacheDocuments` | Also persist live query results and show them `stale` at startup                            |
| `fallback`       | Transports to use when WebSockets are blocked (`transports` from `@canopy/client/fallback`) |
| `lifecycle`      | Reconnect on `online` and `visibilitychange`; `false` turns it off                          |
| `shared`         | Share one connection between tabs, see [multi tab](/guides/multi-tab/)                      |
| `schema`         | The schema from `canopy.schema.ts`: types, `_id` generators and defaults                    |
| `idTypes`        | The `_id` type of each collection, for generated ids, when there is no `schema`             |
| `maxInFlight`    | Mutations sent before their acks arrive (32)                                                |
| `mutationTtlMs`  | How long a queued mutation stays sendable                                                   |
