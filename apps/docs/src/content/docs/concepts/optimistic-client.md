---
title: The optimistic client
description: How the client SDK applies writes locally, queues them offline and reconciles with the server.
---

The client keeps a document cache in two layers: the server state of every live query, and an optimistic
layer of mutations the server has not acknowledged yet. Queries read the merged view.

## Writing

```ts
const handle = canopy.update("todos", id, { $set: { done: true } })
await handle // resolves with the server's result, or rejects with a typed error
```

The update runs locally through the same matcher and update operators as MongoDB, so every live query that
includes the document changes at once. The mutation then goes to the server with a mutation id. If the server
refuses it (a policy, a validation rule, a conflict), the optimistic change is rolled back and the handle
rejects with `PolicyViolationError`, `ValidationError`, `ConflictError` or another `CanopyError`.

## Idempotency

Mutation ids make retries safe. A mutation sent twice after a reconnect is applied once; the second attempt
returns the stored result.

## Offline

With a persister, pending mutations survive reloads and are sent when the connection returns:

```ts
import { createClient } from "canopy.js"
import { indexedDbPersister } from "canopy.js/persist"

const canopy = createClient({
  url: "https://api.example.com",
  publishableKey: "pk_app",
  persist: indexedDbPersister(),
  cacheDocuments: true,
})
```

`cacheDocuments` also keeps the server state of live queries, shown with the `stale` status at startup until
the server answers. Mutations older than `mutationTtlMs` are not sent; they show up in `staleMutations` so
the app can ask the user what to do.

## Reconciling

Server state is ordered by MongoDB cluster time. An acknowledgement carries the cluster time of the write, and
the optimistic layer for that mutation is dropped once the server state has reached it. Because acks come
after their change events, that point is reached before the ack is processed.
