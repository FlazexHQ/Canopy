---
title: Document Level Security
description: How Canopy policies decide which documents and fields each user may read and write.
---

Document Level Security (DLS) follows the semantics of Postgres Row Level Security, applied to documents. A
policy is written once and enforced on every surface: live queries, REST, GraphQL, Studio's "view as user" and
the edge.

## Exposure

A collection is unreachable until its policy file says `exposed: true`. `realtime: true` also allows live
queries on it. Exposed collections with no policy for an operation deny that operation.

## Policies

```ts
import { allow, auth, collection, restrict } from "@canopy/policy"

export default collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
    restrict
      .read("authenticated")
      .where({ archived: { $ne: true } })
      .named("hide archived notes"),
  ],
  immutable: ["ownerId", "createdAt"],
})
```

- **`where`** (the `using` clause) selects which existing documents an operation may touch.
- **`check`** is the condition the resulting document must satisfy after an insert, update or replace.
- **`allow`** policies are permissive and combine with OR; **`restrict`** policies combine with AND on top.
- **Roles** scope a policy. `anon` and `authenticated` are built in; other roles come from a token claim.
  The `service` role (secret keys) bypasses policies and is for server code only.
- **`immutable`** fields may be set on insert but never changed afterwards.

## Variables

| Variable            | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `auth("sub")`       | A claim of the caller's token. `auth("org", "objectId")` coerces it. |
| `ctx("projectIds")` | The result of a context lookup, computed once per request and cached |
| `now("-P7D")`       | The request time, optionally shifted by an ISO 8601 duration         |

A missing claim, a lookup that fails or times out, or an unknown operator denies access.

## Context lookups

Lookups read other collections to answer questions such as "which projects is this user a member of":

```ts
// canopy/policies/_context.ts
import { auth, context } from "@canopy/policy"

export default context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 100,
    ttl: "1m",
  },
})
```

```ts
allow.read("authenticated").where({ projectId: { $in: ctx("projectIds") } })
```

## Field rules

```ts
fields: {
  read: { default: { omit: ["internalNotes"] }, staff: { only: ["*"] } },
  write: { default: { omit: ["status"] } },
}
```

Read rules project fields out of every result and event. Write rules refuse writes that touch a field the
caller may not write.

## How it is enforced

Each policy compiles into two forms from one source: a MongoDB filter, which reads and writes run inside the
database, and an in memory matcher, which decides the visibility of change events. Differential tests against
MongoDB keep both forms equivalent. Writes evaluate `check` inside a multi document transaction together with
an idempotency record, so a refused write leaves nothing behind.

## Testing policies

```ts
import { as, describePolicies } from "@canopy/policy/testing"

describePolicies("notes", ({ doc, expect }) => {
  const note = doc({ _id: "n1", ownerId: "u1", text: "hi" })
  expect(as.user({ sub: "u1" })).can.read(note)
  expect(as.user({ sub: "u2" })).cannot.read(note)
  expect(as.anon()).cannot.read(note)
})
```

`canopy policies test` runs these in memory and, with `--mongodb-uri`, against MongoDB too; both must agree.
`canopy policies explain` shows which policies admit or refuse a given caller and document.
