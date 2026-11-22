---
title: Server rendering
description: Render live data on the server with Next.js Server Components, Nuxt or SvelteKit, then hydrate it.
---

`createServerClient()` from `canopy.js/server` reads through the REST API as the request's user, so
policies apply exactly as they do in the browser. Its results carry their cluster time. `dehydrate()` turns
them into plain JSON for the page, and `client.hydrate()` seeds the browser's live queries with them: queries
with the same filter and options start with the server's documents (shown `stale`) instead of `loading`, and
the socket takes over from that cluster time.

<!-- snippet: declare const cookies: import("canopy.js/server").CookieSource -->

```ts
import { createServerClient, dehydrate } from "canopy.js/server"

const server = createServerClient({ url, publishableKey, cookies })
const todos = await server.find("todos", { done: false }, { sort: { createdAt: -1 }, limit: 50 })
const state = dehydrate([todos])
```

With built in auth on the same site, pass the request's `cookies`; the server client exchanges them for an
access token once per request. With your own identity provider, pass `token` (a string or an async function)
instead. Without either, reads run as `anon`.

## Next.js App Router

```tsx
// app/todos/page.tsx (a Server Component)
import { cookies } from "next/headers"
import { createServerClient, dehydrate } from "canopy.js/server"
import { Hydrate } from "canopy.js/react"
import { TodoList } from "./todo-list"

export default async function Page() {
  const server = createServerClient({ url, publishableKey, cookies: await cookies() })
  const todos = await server.find("todos", { done: false }, { limit: 50 })
  return (
    <Hydrate state={dehydrate([todos])}>
      <TodoList />
    </Hydrate>
  )
}
```

`canopy.js/react` is marked `"use client"`, so `Hydrate` and the hooks render in Client Components under your
`CanopyProvider`. `TodoList` calls `useQuery` with the same filter and options.

## Nuxt

<!-- snippet: not checked -->

```ts
// plugins/canopy.ts
export default defineNuxtPlugin((nuxt) => {
  const state = useState("canopy", () => undefined)
  nuxt.vueApp.use(canopyPlugin(canopy, state.value))
})
```

Read with `createServerClient()` in `useAsyncData` or a server route, put `dehydrate([...])` into
`useState("canopy")`, and `canopyPlugin(client, state)` hydrates the client before components run.

## SvelteKit

<!-- snippet: not checked -->

```ts
// src/routes/todos/+page.server.ts
import { createServerClient, dehydrate } from "canopy.js/server"

export async function load({ cookies }) {
  const server = createServerClient({ url, publishableKey, cookies })
  return { canopy: dehydrate([await server.find("todos", { done: false })]) }
}
```

```svelte
<!-- src/routes/todos/+page.svelte -->
<script lang="ts">
  import { getCanopy, createQuery } from "canopy.js/svelte"
  let { data } = $props()
  const canopy = getCanopy()
  canopy.hydrate(data.canopy)
  const todos = createQuery(canopy.from("todos").find({ done: false }))
</script>
```

SvelteKit's `cookies` has `getAll()`, which is all the server client needs.
