---
title: Infinite live lists
description: A live list that grows as the user scrolls, with every loaded document kept current.
---

A live query keeps every document of its result current. For a feed that grows as the user scrolls, raise the
limit instead of fetching pages: the new query shares the cache with the old one, so documents already loaded
stay on screen while the extra ones arrive.

<!-- snippet: declare function Post(props: { post: object }): null -->
<!-- snippet: declare function LoadMore(props: { onVisible: () => void }): null -->
<!-- snippet: declare function Spinner(): null -->

```tsx
import { useCanopy, useQuery } from "@canopy/react"
import { useMemo, useState } from "react"

const PAGE = 30

function Feed() {
  const canopy = useCanopy<Database>()
  const [limit, setLimit] = useState(PAGE)
  const query = useMemo(
    () => canopy.from("posts").find({ published: true }).sort({ createdAt: -1 }).limit(limit),
    [canopy, limit],
  )
  const { data, status } = useQuery(query)
  const more = data.length === limit

  return (
    <>
      {data.map((post) => (
        <Post key={String(post._id)} post={post} />
      ))}
      {more && <LoadMore onVisible={() => setLimit((current) => current + PAGE)} />}
      {status === "loading" && <Spinner />}
    </>
  )
}
```

- **Always sort.** Without a sort the order of a limited result is undefined, and documents may move between
  loads.
- **Cap the limit.** Each live query keeps its whole result in memory on the client and in the server's merge
  box. Past a few thousand documents, switch older items to [cursor pages](/recipes/pagination/) read once.
- **New documents at the top** arrive without a reload, because they enter the live result. When the list is
  full, the last document leaves it, which is the expected behavior of a limited live query.

With `createReactDb`, the same works through `db.posts.useQuery({ published: true }, { sort: { createdAt: -1 }, limit })`,
which compares its arguments by value.
