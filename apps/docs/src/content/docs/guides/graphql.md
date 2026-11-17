---
title: GraphQL
description: A GraphQL API generated from your collections and policies, with relations, subscriptions and limits.
---

Canopy serves GraphQL at `/graphql/v1`. The schema is generated for each set of roles from your policies and
collection schemas, so a caller only sees the collections, fields and mutations their roles allow. It is
rebuilt when policies or schemas change.

## Queries

For a `todos` collection with a `Todo` type:

```graphql
query Open($after: String) {
  todos(
    filter: { done: { eq: false } }
    sort: [{ field: createdAt, direction: DESC }]
    limit: 20
    after: $after
  ) {
    nodes {
      _id
      title
      done
    }
    next
    total
  }
  todo(id: "64a1b2c3d4e5f6a7b8c9d0e1") {
    title
  }
  todosCount(filter: { done: { eq: true } })
}
```

| Field        | What                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `todos`      | A page: `nodes`, the `next` cursor, `total` (counted only when selected) and the snapshot's `ct` |
| `todo`       | One document by `_id`                                                                            |
| `todosCount` | The number of matching documents                                                                 |

Filters take `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists`, `regex` and `options` per field,
combine with `and`, `or` and `nor`, and accept `raw` for any Extended JSON filter, which is validated like a
REST filter. Type names default to the singular of the collection name; set `collections.<name>.typeName` in
the config where the guess is wrong.

## Mutations

Each collection gets `insertTodo`, `insertTodos`, `replaceTodo`, `updateTodo`, `updateTodos`, `deleteTodo` and
`deleteTodos`, as far as the caller's policies allow those operations:

```graphql
mutation {
  updateTodo(id: "64a1b2c3d4e5f6a7b8c9d0e1", update: { set: { done: true } }) {
    _id
    done
  }
}
```

Updates take `set`, `inc` and `unset`, or `raw` update operators. Mutations run through the same transactional
write path as REST, `check` clauses included. A request with a single root mutation honors `Idempotency-Key`.

## Relations

```ts
import { defineConfig } from "@canopy/config"

export default defineConfig({
  collections: {
    posts: { relations: { author: { to: "users", local: "authorId" } } },
    users: { relations: { posts: { to: "posts", local: "_id", foreign: "authorId", many: true } } },
  },
})
```

`post { author { name } }` then resolves the author under the `users` policies. Lookups are batched per
request, so a page of 100 posts reads its authors in one query.

## Subscriptions

```graphql
subscription {
  liveTodos(filter: { done: { eq: false } }, limit: 50) {
    _id
    title
  }
}
```

`liveTodos` sends the whole result whenever it changes; `todoChanges` sends each added, changed and removed
document, then `ready`. Both run on Canopy realtime, with the same snapshot and ordering guarantees. They are
served over server sent events on every runtime and over graphql-ws (`graphql-transport-ws`) on Node.

## Limits

| Setting         | Default | What                                                         |
| --------------- | ------- | ------------------------------------------------------------ |
| `maxDepth`      | 10      | Nesting depth of a selection                                 |
| `maxComplexity` | 5000    | Every field costs 1, times the `limit` of each list above it |
| `maxAliases`    | 30      | Aliased fields in one operation                              |
| `maxBatch`      | 10      | Operations in one batched request                            |

Introspection is `authenticated` in production and `always` otherwise. With
`graphql: { persisted: { file: "operations.json", only: true } }`, only operations whose SHA-256 is in the file
run.

## Studio

Studio's API page has a GraphQL explorer with completion and the schema docs. It can run operations as the
`service` role or as an impersonated user, read only.
