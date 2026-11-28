---
title: Client SDK
description: Live queries, optimistic writes and typed collections with canopy.js.
---

## Run from a clone

Install Bun 1.4 or newer and Node.js 24 or newer. Start the authenticated notes server from the repository root.

```bash
git clone https://github.com/FlazexHQ/Canopy.git
cd Canopy
bun install --frozen-lockfile
bun run build
bun run db:up
node examples/auth-notes/src/server.ts
```

Without Docker, replace `bun run db:up` with
`bun packages/testing/scripts/mongod.ts --version 8.0.34 --dir .canopy/mongo`.
If you are reading the guide on a feature branch, check out that branch after cloning and before building.

In a second terminal, change to `examples/auth-notes`, which declares the SDK workspace dependencies.
Save the following program there as `sdk-demo.mjs` for JavaScript or `sdk-demo.ts` for TypeScript.
Both use the same schema value and infer types from the `schema` option. Run `node sdk-demo.mjs` or
`node sdk-demo.ts`, respectively.

```js
// @ts-check
import { createClient } from "canopy.js"
import { createAuth } from "canopy.js/auth"
import { createRestClient } from "canopy.js/rest"
import { collection, defineSchema, t } from "@canopy/schema/define"

const schema = defineSchema(
  collection("notes", { text: t.string(), ownerId: t.string(), createdAt: t.date() }),
)
const url = "http://localhost:3000"
const auth = createAuth({ url })
const email = `demo-${crypto.randomUUID()}@example.com`
await auth.signUp({ email, password: "local-demo-password" })
const user = auth.user
if (user === undefined) throw new Error("Sign-up did not establish a session")

const options = { url, publishableKey: "pk_notes_local", auth, schema }
const canopy = createClient(options)
const notes = canopy.from("notes")
const live = notes.find({ ownerId: user.id }).fields({ text: 1 })
const stop = live.subscribe(({ data, status }) => {
  console.log("live", status, data.map((note) => note.text))
})
try {
  // Wait for the server's initial snapshot before writing a note.
  const deadline = Date.now() + 10_000
  while (live.getState().status !== "ready") {
    if (Date.now() >= deadline) throw new Error("Live query did not become ready")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const added = notes.insert({ text: "Buy milk", ownerId: user.id, createdAt: new Date() })
  console.log("new id", added.id)
  await added

  const rest = createRestClient(options)
  const page = await rest.from("notes").find({ ownerId: user.id }).fields({ text: 1 }).limit(20).page()
  console.log("REST page", page.data.map((note) => note.text))
} finally {
  stop()
  canopy.close()
}
```

The live query prints its initial snapshot and the update. The REST page prints `Buy milk`. In JavaScript
the `@ts-check` directive enables editor diagnostics, including checks on the projected field names.

## Verify your email

The notes demo runs without email verification. If your app requires verification, ask the user to
enter an email code in the same app after signing up. Call `sendVerificationOtp` to send the code, then
call `verifyEmailWithOtp` when the user submits it.

<!-- snippet: declare const otp: string -->

```ts
await auth.sendVerificationOtp({ email })
await auth.verifyEmailWithOtp({ email, otp })
```

With the Rust auth server, Canopy.js sends the proof it received at sign up when it submits the code,
including in bearer mode. Configure `storage` on `createAuth` to keep the proof across app reloads.
A verification link opened in the browser that signed up can use the sign up cookie to keep the original
password. A link opened in another browser or device, or a link opened from a bearer mode app, normally
has no proof. On first verification without the proof, the address is verified and the password is removed.
Have the user reset their password to sign in with a password again.

## Configure a client

<!-- snippet: declare const identityProvider: { getAccessToken(): Promise<string> } -->

```ts
import { createClient } from "canopy.js"

const canopy = createClient({
  url: "https://api.example.com",
  publishableKey: "pk_app",
  auth: { getToken: () => identityProvider.getAccessToken() },
})
```

`auth` is anything with a `getToken()` method: your identity provider's SDK, or `createAuth()` from
`canopy.js/auth` for [built in auth](/concepts/auth/). The token is read on every connect and before it
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

Declare your collections in `canopy.schema.ts` and pass the schema to the client. From a built clone,
`node packages/cli/dist/cli.js pull` can write the first version. Queries and writes are checked against
the schema, and inserts take their `_id` generator and defaults from it. See [Schema in code](/guides/schema/).

```ts
import { createClient } from "canopy.js"
import { schema } from "./canopy.schema.ts"

const typed = createClient({ url, publishableKey, schema })
// @ts-expect-error done is a boolean
typed.from("todos").find({ done: "yes" })
```

Existing handwritten `Database` types still work with `createClient<Database>()`.

## One-off reads over HTTP

For an export, a filter dropdown or a server job, `canopy.js/rest` reads through the Data API with the
same identity and policies as a live query, without a WebSocket or a document cache. Building a query sends
nothing; `page()`, `findById()` and `count()` each make one request.

<!-- snippet: declare const signal: AbortSignal -->

```ts
import { createRestClient } from "canopy.js/rest"
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

The same client writes without a socket when a server job or a form post needs it. `patch` sends a JSON merge
patch: named fields are set, subdocuments merge field by field, arrays are replaced and `null` removes an
optional field. `batch` sends several writes in one request, and you choose whether they are atomic. An
`idempotencyKey` makes either safe to retry after a lost response: the server answers a repeated key with the
stored result and `replayed: true` instead of writing again.

<!-- snippet: import { schema } from "./canopy.schema.ts" -->
<!-- snippet: const rest = (await import("canopy.js/rest")).createRestClient({ url, publishableKey, auth: { getToken }, schema }) -->

```ts
await rest.from("notes").patch(
  "agenda",
  { body: { text: "Ship it", format: "plain" } },
  { where: { title: "Agenda" }, idempotencyKey: "note-agenda-001" },
)

const { results } = await rest.batch(
  [
    { op: "insert", c: "todos", doc: { title: "Write the notes", due: null } },
    { op: "delete", c: "todos", id: "todo-old" },
  ],
  { atomic: true, idempotencyKey: "cleanup-2026-11-20" },
)
render(results)
```

With `atomic: true` every operation applies or none does, and a refused operation rejects the call. With
`atomic: false` each operation applies on its own and `results` holds an `ok` outcome or a typed `error` per
operation. Optimistic writes, the offline outbox and echo before ack stay with the realtime client.

## Connection status

`canopy.connectionStatus` is `connecting`, `live`, `fallback` (on SSE or long polling), `reconnecting`,
`offline` or `closed`, and `canopy.onStatus(listener)`
reports changes. Mutations made offline are queued and sent in order on reconnect.

## Options

| Option           | What                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `persist`        | A persister, so pending mutations and the session survive reloads                           |
| `cacheDocuments` | Also persist live query results and show them `stale` at startup                            |
| `fallback`       | Transports to use when WebSockets are blocked (`transports` from `canopy.js/fallback`) |
| `lifecycle`      | Reconnect on `online` and `visibilitychange`; `false` turns it off                          |
| `shared`         | Share one connection between tabs, see [multi tab](/guides/multi-tab/)                      |
| `schema`         | The schema from `canopy.schema.ts`: types, `_id` generators and defaults                    |
| `idTypes`        | The `_id` type of each collection, for generated ids, when there is no `schema`             |
| `maxInFlight`    | Mutations sent before their acks arrive (32)                                                |
| `mutationTtlMs`  | How long a queued mutation stays sendable                                                   |
