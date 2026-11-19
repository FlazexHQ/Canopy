---
title: React, Vue, Svelte and Solid
description: Framework bindings for live queries, connection status and mutations.
---

Every binding wraps the same client: queries are shared between components, optimistic writes show at once,
and the subscription ends when the last component using it unmounts. All four pass the protocol conformance
vectors. Once your `canopy.schema.ts` registers its schema (see [Schema in code](/guides/schema/)), the hooks
and accessors below are typed by it with no type argument.

## React

```bash
bun add @canopy/client @canopy/react
```

<!-- snippet: registered -->

```tsx
import { CanopyProvider, createReactDb, useCanopyStatus, useDocument } from "@canopy/react"

const db = createReactDb(canopy)

function Todos() {
  const todos = db.todos.useQuery({ done: false }, { sort: { createdAt: -1 }, limit: 50 })
  const status = useCanopyStatus()
  if (todos.status === "loading") return <p>Loading</p>
  return todos.data.map((todo) => (
    <label key={String(todo._id)}>
      <input type="checkbox" onChange={() => db.todos.update(todo._id, { $set: { done: true } })} />
      {todo.title}
    </label>
  ))
}

function Todo({ id }: { id: string }) {
  const { data } = useDocument("todos", id)
  return <h1>{data?.title}</h1>
}

export const App = () => (
  <CanopyProvider client={canopy}>
    <Todos />
  </CanopyProvider>
)
```

`useQuery(liveQuery)` takes any query from `canopy.from(...)`. `useSession()` returns the signed in user of
built in auth, `useMutationError()` and `useStaleMutations()` surface failed and expired writes.

## Vue

```bash
bun add @canopy/client @canopy/vue
```

```ts
import { canopyPlugin } from "@canopy/vue"
import { createApp } from "vue"
import App from "./App.vue"

createApp(App).use(canopyPlugin(canopy)).mount("#app")
```

```vue
<script setup lang="ts">
import { ref } from "vue"
import { useCanopy, useMutation, useQuery } from "@canopy/vue"

const canopy = useCanopy()
const showDone = ref(false)
const { data, status } = useQuery(() => canopy.from("todos").find({ done: showDone.value }))
const finish = useMutation((id: string) => canopy.update("todos", id, { $set: { done: true } }))
</script>

<template>
  <p v-if="status === 'loading'">Loading</p>
  <button v-for="todo in data" :key="String(todo._id)" @click="finish.mutate(todo._id)">{{ todo.title }}</button>
</template>
```

`useQuery` takes a query, a ref or a getter; when the getter's dependencies change it switches queries.
`useMutation` exposes `pending`, `error` and `result` refs. `useCanopyStatus()` is a ref of the connection
status.

## Svelte 5

```bash
bun add @canopy/client @canopy/svelte
```

```svelte
<script lang="ts">
  import { createQuery, getCanopy } from "@canopy/svelte"

  const canopy = getCanopy()
  const todos = createQuery(canopy.from("todos").find({ done: false }))
</script>

{#each todos.data as todo (String(todo._id))}
  <p>{todo.title}</p>
{/each}
```

Call `setCanopy(canopy)` in a root component. A query subscribes while a template, `$derived` or `$effect`
reads it, and also follows the store contract, so `$todos` works. `canopyStatus(canopy).current` is the
connection status.

## Solid

```bash
bun add @canopy/client @canopy/solid
```

<!-- snippet: registered -->
<!-- snippet: /** @jsxImportSource solid-js */ -->
<!-- snippet: declare const root: HTMLElement -->

```tsx
import { CanopyProvider, createQuery, useCanopy } from "@canopy/solid"
import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"

function Todos() {
  const canopy = useCanopy()
  const [showDone, setShowDone] = createSignal(false)
  const todos = createQuery(() => canopy.from("todos").find({ done: showDone() }))
  return <For each={todos.data()}>{(todo) => <p>{todo.title}</p>}</For>
}

render(
  () => (
    <CanopyProvider client={canopy}>
      <Todos />
    </CanopyProvider>
  ),
  root,
)
```

`createQuery` takes a query or an accessor; `createCanopyStatus()` is an accessor of the connection status.
