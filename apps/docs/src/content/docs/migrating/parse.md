---
title: From Parse Server
description: Serve a Parse Server database with Canopy, keep its ACLs and import its users with their passwords.
---

Parse Server stores its classes as MongoDB collections, so Canopy can serve the same database without moving
any data. Run both side by side while clients move over.

## What maps to what

| Parse                          | Canopy                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| Classes                        | Collections of the same name                                     |
| ACLs (`_rperm`, `_wperm`)      | Policies that read those fields                                  |
| Class level permissions        | Roles on policies, and `exposed`                                 |
| `Parse.Query`                  | Live queries and the REST Data API with MongoDB filters          |
| Live Query                     | Live queries, with the same policies and ordered delivery        |
| `_User` and sessions           | Built in auth, with users imported including their bcrypt hashes |
| `_Role`                        | Roles in tokens, or a context lookup on `_Role`                  |
| Cloud Code functions and hooks | Your own server; `beforeSave` validation becomes `check` clauses |
| Pointers (`_p_owner`)          | GraphQL relations, or a plain id field                           |

## 1. Expose the classes

```bash
bunx canopy init --mongodb-uri "mongodb://parse-db:27017/parse?replicaSet=rs0"
```

Parse fields keep their stored names: `_id` is a string, timestamps are `_created_at` and `_updated_at`,
pointers are strings such as `_User$k3d9Fq` in `_p_<field>`.

## 2. Turn ACLs into policies

Parse writes each document's readers to `_rperm` and writers to `_wperm`: `*` for everyone, user ids, and
`role:<name>`. The same rules as a policy:

```ts
import { allow, auth, collection } from "@canopy/policy"

export default collection("Post", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("anon", "authenticated").where({ _rperm: "*" }).named("public"),
    allow
      .read("authenticated")
      .where({ _rperm: auth("sub") })
      .named("readers"),
    allow
      .update("authenticated")
      .where({ _wperm: auth("sub") })
      .check({ _wperm: auth("sub") })
      .named("writers"),
    allow
      .delete("authenticated")
      .where({ _wperm: auth("sub") })
      .named("deleters"),
  ],
  fields: { read: { default: { omit: ["_rperm", "_wperm", "_acl"] } } },
})
```

For role entries, put the user's Parse roles into a token claim as `role:<name>` strings (a claims hook can
read `_Role`), then match with `{ _rperm: { $in: auth("parse_roles") } }`.

Imported users get new ids. The importer keeps the Parse id (the `id` field below) in
`app_metadata.importedFrom.id`, which is in
every access token, so `auth("app_metadata.importedFrom.id")` matches the ids already stored in `_rperm`,
`_wperm` and pointers. Use it in place of `auth("sub")` above while those documents hold Parse ids.

## 3. Import users with their passwords

Parse stores bcrypt hashes in `_hashed_password`, which built in auth verifies at the first sign in and then
rehashes. Export the users to CSV with the header names the importer reads:

```bash
mongoexport --uri "$PARSE_DB" --collection _User --type csv --fields _id,email,emailVerified,username,_hashed_password,_created_at --out users.csv
```

Rename the header line to `id,email,email_verified,name,password_hash,created_at`. bcrypt hashes are
recognized by their `$2` prefix, and `id` keeps each user's Parse id. Then:

```bash
canopy auth import users.csv --from csv --env production --dry-run
canopy auth import users.csv --from csv --env production
```

Users without an email (username only) are skipped and listed; give them an email first or keep them on Parse
until they add one.

## 4. Move clients

```ts
// Parse
const query = new Parse.Query("Post").equalTo("published", true).descending("_created_at").limit(20)
const subscription = await query.subscribe()

// Canopy
canopy.from("Post").find({ published: true }).sort({ _created_at: -1 }).limit(20).subscribe(render)
```

Writes from Canopy do not run Parse's `beforeSave` hooks and do not maintain `_updated_at` or the ACL fields;
set them in the write, enforce them with `check` and `immutable`, or keep those writes on Parse until the hooks
are ported.
