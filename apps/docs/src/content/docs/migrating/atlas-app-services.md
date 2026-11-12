---
title: From Atlas App Services
description: Replace App Services rules, the Data API, Device Sync, GraphQL and auth with Canopy on the same Atlas cluster.
---

Canopy runs against the Atlas cluster your App Services app already uses. Your data stays where it is and
keeps its shape; Canopy keeps its own state in the `canopy` and `canopy_auth` databases. You can move one
feature at a time while the App Services app keeps running.

## What maps to what

| App Services                                      | Canopy                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Rules: roles, document filters, field permissions | [Policies](/concepts/document-level-security/) with roles, `where`, `check` and field rules             |
| Data API (HTTPS endpoints)                        | The [REST Data API](/guides/rest/)                                                                      |
| GraphQL API                                       | [Canopy GraphQL](/guides/graphql/), generated from policies and schemas                                 |
| Device Sync and Realm SDKs                        | [Live queries](/concepts/realtime/) with the [optimistic, offline client](/concepts/optimistic-client/) |
| `collection.watch()` in the Web SDK               | Live queries, or a change stream in your own server                                                     |
| Authentication providers                          | [Built in auth](/concepts/auth/), or your own identity provider                                         |
| API keys                                          | Publishable and secret keys                                                                             |
| Functions and HTTPS endpoints                     | Your own server, with Canopy [embedded](/start/embedded/) in it or beside it                            |
| Triggers                                          | Change streams in your own worker; Canopy does not run user code                                        |
| Schemas (JSON Schema)                             | Collection validators, which `canopy gen types` turns into TypeScript                                   |

## 1. Connect Canopy to the cluster

Create a database user for Canopy with `read` (or `readWrite` for writes) on the app database and
`readWrite` on `canopy` and `canopy_auth`, then run `canopy init` against the cluster:

```bash
bunx canopy init --mongodb-uri "mongodb+srv://canopy:PASSWORD@cluster0.example.mongodb.net/app"
bunx canopy doctor
```

## 2. Translate the rules

An App Services role such as

```json
{
  "name": "owner",
  "apply_when": {},
  "document_filters": { "read": { "owner_id": "%%user.id" }, "write": { "owner_id": "%%user.id" } },
  "read": true,
  "write": true,
  "insert": true,
  "delete": true
}
```

becomes

```ts
import { allow, auth, collection } from "@canopy/policy"

const own = { owner_id: auth("sub") }

export default collection("items", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where(own),
    allow.insert("authenticated").check(own),
    allow.update("authenticated").where(own).check(own),
    allow.delete("authenticated").where(own),
  ],
})
```

| App Services expansion | Canopy                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `%%user.id`            | `auth("sub")`                                                             |
| `%%user.data.<field>`  | A claim from a claims hook, or a [context lookup](/recipes/multi-tenant/) |
| `%%user.custom_data`   | A context lookup on your custom user data collection                      |
| `%%root`, `%%prevRoot` | `check` (the new document) and `where` (the existing one)                 |
| `apply_when`           | Roles on the policy, or a `where` clause                                  |
| Field `read: false`    | `fields: { read: { default: { omit: ["field"] } } }`                      |
| `%function` calls      | Not supported: compute the value into a claim or a document field         |

Write a policy test for each role, and run `canopy policies test --mongodb-uri` so the rules are checked
against MongoDB itself.

## 3. Move clients

Replace `app.currentUser.mongoClient("mongodb-atlas").db("app").collection("items")` reads with live queries:

```ts
const items = canopy.from("items").find({ status: "open" }).sort({ createdAt: -1 }).limit(100)
items.subscribe(({ data }) => render(data))
await canopy.update("items", id, { $set: { status: "done" } })
```

The client has no local database. With a persister it keeps pending writes and the last results across
restarts and works offline; it does not sync whole partitions to the device like Device Sync.

## 4. Move users

App Services cannot export password hashes, so email and password users set a new password:

1. Export the users (the Admin API lists them) into a CSV with the fields `email`, `name` and `created_at`.
2. `canopy auth import users.csv --from csv --env production`.
3. Send each user a password reset or a magic link. With `emailOtp` or `magicLink` on, they can sign in
   without a password at all.

Users of custom JWT authentication keep their identity provider: configure it with `external()` and nothing
changes for them. Anonymous users start fresh.

## 5. Retire App Services

Once clients read and write through Canopy, turn off the Data API, GraphQL and Device Sync in App Services,
then the app itself. Functions and triggers that still run move to your own server or worker, reading the
same change streams.
