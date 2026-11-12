---
title: Client SDK
description: Live queries, optimistic writes and typed collections with @canopy/client.
---

```bash
bun add @canopy/client
```

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

Each call returns a `MutationHandle`: the change is visible locally at once, and the handle resolves with the
write's cluster time and counts when the server acknowledges it, or rejects with a typed error after the local
change is rolled back. Single document writes take `{ where }`, a compare and set precondition that fails with
`ConflictError`.
`canopy.onMutationError(listener)` reports failures in one place.

## Types

Generate types from your collection schemas and policies (written to `types.out` in the config, else
`src/canopy.gen.ts`):

```bash
bunx canopy gen types
```

```ts
import type { Database } from "./canopy.gen.ts"

const canopy = createClient<Database>({ url, publishableKey })
canopy.from("todos").find({ done: "yes" }) // a type error: done is a boolean
```

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
| `idTypes`        | The `_id` type of each collection, for generated ids                                        |
| `maxInFlight`    | Mutations sent before their acks arrive (32)                                                |
| `mutationTtlMs`  | How long a queued mutation stays sendable                                                   |
