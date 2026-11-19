---
title: Schema in code
description: Declare your collections once in canopy.schema.ts, and get typed queries, IDs and defaults everywhere.
---

Your app declares its collections in one file, `canopy.schema.ts`. Every field builder carries its TypeScript
type, so the client, the REST reader, the framework bindings and the helper types are typed from that file
with no generic parameter, and the client takes each collection's `_id` generator and defaults from the same
definition. The file is ordinary source code: you edit it, review it and commit it.

## Write the first version with `canopy pull`

```bash
bunx canopy pull
```

`canopy pull` reads each collection's `$jsonSchema` validator, then the config, then a sample of documents,
and writes `canopy.schema.ts` (`--js` writes `canopy.schema.js`, `--out` picks another path). Fields and
enums it only saw in sampled documents carry a `TODO(canopy pull)` comment: check them, then delete the
comment. Once the file exists, `canopy pull` refuses to overwrite your edits and prints the difference
instead; `--force` replaces it, and `--collection <name>` adds one collection to it.

## Declare collections

<!-- snippet: not checked -->

```ts
// canopy.schema.ts
import type {} from "@canopy/client"
import { collection, defineSchema, t } from "@canopy/schema/define"

export const todos = collection("todos", {
  title: t.string(),
  done: t.bool().default(false),
  tags: t.array(t.string()).optional(),
  due: t.date().nullable(),
  ownerId: t.string(),
})

export const notes = collection("notes", {
  _id: t.string(),
  title: t.string(),
  body: t.object({ text: t.string(), format: t.enum(["md", "plain"]) }),
})

export const schema = defineSchema(todos, notes)

declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
```

The `declare module` block registers the schema. After that, `createClient` and `createRestClient` require
the `schema` option (so a missing runtime definition is a compiler error), and `CanopyClient`, `ReactDb` and
the helper types use it by default. The type import on the first line makes the registration resolve even in
a program, such as a server, that imports nothing else from the client.

| Builder                                                     | Type of the value                       |
| ----------------------------------------------------------- | --------------------------------------- |
| `t.string()`, `t.bool()`, `t.date()`                        | `string`, `boolean`, `Date`             |
| `t.int()`, `t.double()`                                     | `number`                                |
| `t.long()`                                                  | `number`, or `Long` beyond 2^53         |
| `t.objectId()`, `t.decimal()`                               | `ObjectId`, `Decimal128`                |
| `t.uuid()`, `t.binary()`                                    | `Binary` (a UUID is subtype 4)          |
| `t.array(item)`, `t.object({ ... })`                        | an array, a subdocument                 |
| `t.enum(["a", "b"])`, `t.union(t.string(), t.int())`, `t.any()` | `"a" \| "b"`, a union, `unknown`    |

Modifiers: `.optional()` lets the field be absent, `.nullable()` lets the value be `null`, and
`.default(value)` makes the field optional on insert: the client fills it in before the optimistic write, so
the cached document and the stored one match.

## IDs come from the `_id` builder

A collection without `_id` gets ObjectIds the client generates. `_id: t.uuid()` generates UUIDv7s. Any other
`_id` type (`t.string()`, `t.int()`, `t.long()` and so on) must be supplied on insert, unless its builder
has `.generate(() => ...)`. Because the client reads the same definition the types come from, the ID on a
mutation handle always has the type the schema declares.

```ts
import { createClient } from "@canopy/client"
import { schema } from "./canopy.schema.ts"

const client = createClient({ url, publishableKey, schema })

const note = client.from("notes").insert({ _id: "agenda", title: "Agenda", body: { text: "", format: "md" } })
const noteId: string = note.id
await note

const todo = client.from("todos").insert({ title: "Ship", ownerId: "u1", due: null })
// todo.id is an ObjectId, and the stored document has done: false

// @ts-expect-error notes take caller supplied string ids
client.from("notes").insert({ title: "No id", body: { text: "", format: "plain" } })
```

An insert that leaves out a caller supplied `_id` throws a `TypeError` before anything is queued, including
for every document of `insertMany`.

## Name your types

With the schema registered, the helpers take a collection name:

<!-- snippet: not checked -->

```ts
import type { Doc, Id, NewDoc, Patch } from "@canopy/client"

function TodoRow(props: { todo: Doc<"todos"> }) {
  return props.todo.title
}
const draft: NewDoc<"todos"> = { title: "Ship", ownerId: "u1", due: null } // _id and done are optional
const complete = (id: Id<"todos">) => client.from("todos").update(id, { $set: { done: true } })
const rename: Patch<"todos"> = { title: "Ship it", tags: null } // a merge patch: null removes tags
```

Code that cannot rely on the registered schema, such as a library or an app with two Canopy backends, passes
the schema as a second argument: `Doc<"todos", typeof schema>`.

## Validate with Standard Schema

Each collection definition implements [Standard Schema](https://standardschema.dev), so a library that
accepts one can validate a decoded document with it:

<!-- snippet: declare const value: unknown -->

```ts
import { todos } from "./canopy.schema.ts"

const result = await todos["~standard"].validate(value)
if (result.issues !== undefined) console.error(result.issues)
```

## JavaScript

Since the schema is a runtime value, checked JavaScript gets the same types from the factory argument, with
no annotation and no `Register` block:

```js
// @ts-check
import { createClient } from "@canopy/client"
import { schema } from "./canopy.schema.js"

const canopy = createClient({ url, publishableKey, schema })
const titles = canopy.from("todos").find({ done: false }).fields({ title: 1 })
```

## Keep the database and the file in step

```bash
bunx canopy schema diff        # exits 1 and lists each difference when MongoDB drifted
bunx canopy schema push        # writes the declared collections' validators, after asking
```

`canopy schema diff` compares the file with each collection's validator, or with sampled documents when a
collection has none, and is the check to run in CI. A declared type wider than the stored values is fine;
a field the database has and the file does not declare is a difference. `canopy dev` runs the same
comparison when collections change and warns instead of changing anything.

`canopy schema push` converts each declared collection to a `$jsonSchema` validator and applies it with
`createCollection` or `collMod`. It is an explicit admin action: it shows what it will change, asks first
(`--yes` skips the question), never runs at startup and never touches a collection the file does not declare.

Static types describe a collection, not what one role may do: Document Level Security still decides every
request at runtime. `canopy schema diff --role <role>` adds a report of the declared fields that role cannot
read, or cannot write on insert, under the field rules of your policies.

## Moving from `canopy gen types`

`canopy gen types` and `createClient<Database>()` keep working for now; `gen types` prints a notice that
points here. To move, run `canopy pull`, register the schema, pass it to `createClient`, replace
`Database["todos"]["Document"]` with `Doc<"todos">`, and replace `canopy gen types --check` in CI with
`canopy schema diff`.
