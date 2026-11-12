---
title: TanStack DB
description: Use Canopy collections as TanStack DB collections, with live sync and Canopy mutations.
---

`@canopy/tanstack-db` exposes a Canopy collection as a TanStack DB collection, so TanStack DB's live queries,
joins and optimistic transactions work on top of Canopy's realtime sync and policies.

```bash
bun add @canopy/client @canopy/tanstack-db @tanstack/db
```

```ts
import { canopyCollectionOptions } from "@canopy/tanstack-db"
import { createCollection } from "@tanstack/db"

const todos = createCollection(
  canopyCollectionOptions({
    client: canopy,
    collection: "todos",
    filter: { done: false },
    limit: 500,
  }),
)

await todos.preload()
todos.insert({ _id: crypto.randomUUID(), title: "Write docs", done: false })
todos.update(id, (draft) => {
  draft.done = true
})
```

- **Sync.** The TanStack DB collection is filled from a Canopy live query. `filter`, `sort` and `limit` choose
  which documents it holds; policies still decide what the user may see. Changes made anywhere arrive as they
  happen.
- **Writes.** Inserts, updates and deletes run as Canopy mutations with their idempotent mutation ids. Updates
  send `$set` for changed fields and `$unset` for removed ones. When the server refuses a write, the TanStack DB
  transaction rolls back with Canopy's typed error.
- **Keys.** Documents are keyed by `_id`: an ObjectId by its hex, numbers and strings by their text. Pass
  `getKey` to choose another key.

The adapter targets the `@tanstack/db` 1.0 release candidates.
