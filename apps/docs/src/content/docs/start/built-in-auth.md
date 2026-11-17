---
title: Built in auth quickstart
description: Email and password accounts, private documents and a live query, with no external identity provider.
---

This quickstart runs Canopy with its own user accounts: people sign up with an email address and a password,
and each of them sees a live list of their own notes. The finished app is
[`examples/auth-notes`](https://github.com/FlazexHQ/Canopy/tree/master/examples/auth-notes) in the repository,
with browser tests.

You need Node.js 24 or later (or Bun) and a MongoDB replica set; `bunx canopy dev --with-mongo` or
`bun run db:up` in a clone of the repository starts one.

## 1. Write the policy

Each note carries the id of its owner, and the policy compares it with the `sub` claim of the caller's
token, which built in auth sets to the user id:

```ts
// canopy/policies/notes.ts
import { allow, auth, collection } from "@canopy/policy"

export default collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }).check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  immutable: ["ownerId"],
})
```

Anonymous callers match no rule, so they read nothing and cannot write.

## 2. Turn on built in auth

```ts
// canopy/canopy.config.ts
import { builtin, defineConfig, env } from "@canopy/config"

export default defineConfig({
  mongodb: { uri: env("MONGODB_URI"), database: "notes" },
  publicUrl: "http://localhost:8080",
  masterKey: env.secret("CANOPY_MASTER_KEY"),
  auth: builtin({ emailPassword: { minPasswordLength: 10, requireEmailVerification: false } }),
  keys: { publishable: ["pk_notes_dev"] },
  policies: { dir: "./policies" },
})
```

`masterKey` encrypts the token signing keys at rest; use at least 32 random characters and keep it secret.
Users live in the `notes_auth` database and Canopy's own state in `notes_meta`; the `notes` database only
holds your documents. Email verification is off so the quickstart needs no mail server. In production, turn
it on and configure `email` (see [auth](/concepts/auth/)).

Start it with `bunx canopy dev`, which prints the URLs, or embed it with `createCanopy` as
[the embedded guide](/start/embedded/) shows.

## 3. Sign up and sign in from the browser

```ts
import { createClient, type DocumentSchema } from "@canopy/client"
import { createAuth } from "@canopy/client/auth"
import { indexedDbPersister } from "@canopy/client/persist"

interface Note {
  readonly _id: string
  text: string
  ownerId: string
  createdAt: Date
}

const auth = createAuth({ url: "http://localhost:8080", storage: indexedDbPersister() })
const canopy = createClient<DocumentSchema<{ notes: Note }>>({
  url: "http://localhost:8080",
  publishableKey: "pk_notes_dev",
  auth,
})

await auth.signUp({ email: "ann@example.com", password: "a long password" })
// later, or on another device:
await auth.signInWithPassword({ email: "ann@example.com", password: "a long password" })
```

With verification off, `signUp` signs the user in at once. The session is kept in IndexedDB, so a reload
stays signed in; `auth.signOut()` ends it. A wrong password rejects with an `AuthError` whose code is
`INVALID_EMAIL_OR_PASSWORD`.

## 4. Write and read live

<!-- snippet: declare const auth: import("@canopy/client/auth").CanopyAuth -->
<!-- snippet: declare const canopy: import("@canopy/client").CanopyClient<import("@canopy/client").DocumentSchema<{ notes: { readonly _id: string; text: string; ownerId: string; createdAt: Date } }>> -->

```ts
const user = auth.user
if (user !== undefined) {
  await canopy.insert("notes", { text: "Buy milk", ownerId: user.id, createdAt: new Date() })
  canopy
    .from("notes")
    .find({ ownerId: user.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .subscribe(({ data, status }) => render(data, status))
}
```

The insert shows up in the list at once and is confirmed by the server; a note added in another tab of the
same user appears live. Inserting a note with someone else's `ownerId` is refused with
[`CANOPY_POLICY_VIOLATION`](/errors/policy-violation/), and another user's list never contains it.

## Next

- [Two factor and passkeys](/guides/two-factor-and-passkeys/) on the same accounts.
- [Server rendering](/guides/server-rendering/) with the session cookie.
- [Import users](/guides/importing-users/) from another system.
