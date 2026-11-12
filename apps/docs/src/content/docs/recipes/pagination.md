---
title: Pagination
description: Page through large collections with cursors over REST and GraphQL.
---

Cursor pagination is stable while documents are inserted and deleted, and it stays fast on large collections
because each page starts from an index position instead of skipping documents.

## REST

```bash
curl "https://api.example.com/rest/v1/orders?sort=-createdAt&limit=50" -H "apikey: pk_app" -H "authorization: Bearer $TOKEN"
```

The answer's `page.next` is the cursor of the next page, or `null` on the last one:

```bash
curl "https://api.example.com/rest/v1/orders?sort=-createdAt&limit=50&after=$NEXT" ...
```

Keep the same filter, sort and limit for every page; a cursor from another query is refused. Sorts are made
unique with `_id` behind the scenes, so documents with equal sort keys are neither repeated nor skipped. Add an
index on the sort keys (with `_id` last) for large collections; `canopy indexes advise` suggests indexes for
your policies.

`count=exact` adds `page.total`. Counting reads every matching document, so ask for it only on the first page,
or use `count=estimated`.

## GraphQL

```graphql
query Orders($after: String) {
  orders(sort: [{ field: createdAt, direction: DESC }], limit: 50, after: $after) {
    nodes {
      _id
      total
    }
    next
  }
}
```

## From TypeScript

```ts
let after: string | undefined
do {
  const response = await fetch(
    `${url}/rest/v1/orders?sort=-createdAt&limit=50${after ? `&after=${after}` : ""}`,
    {
      headers: { apikey: publishableKey, authorization: `Bearer ${await auth.getToken()}` },
    },
  )
  const page = await response.json()
  handle(page.data)
  after = page.page.next ?? undefined
} while (after !== undefined)
```

Live queries do not page with cursors; see [infinite live lists](/recipes/infinite-lists/).
