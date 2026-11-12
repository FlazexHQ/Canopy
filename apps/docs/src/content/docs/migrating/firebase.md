---
title: From Firebase
description: Move a Firestore app to MongoDB and Canopy, with security rules as policies and users imported with their passwords.
---

Moving from Firebase has two parts: the data moves from Firestore to MongoDB, and the backend features map onto
Canopy. Firebase Authentication can stay, or its users move to built in auth with their passwords.

## What maps to what

| Firebase                 | Canopy                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Firestore collections    | MongoDB collections                                                                         |
| Subcollections           | Collections with a parent id field (`posts/{id}/comments` becomes `comments` with `postId`) |
| Security Rules           | [Policies](/concepts/document-level-security/)                                              |
| `onSnapshot`             | Live queries                                                                                |
| Offline persistence      | A [persister](/concepts/optimistic-client/) with `cacheDocuments`                           |
| Firebase Authentication  | `external.firebase()` to keep it, or built in auth after an import                          |
| Custom claims            | Token claims, read with `auth("claim")`                                                     |
| Cloud Functions triggers | Change streams in your own worker                                                           |
| Callable functions       | Your own server, with Canopy beside it                                                      |

## 1. Move the data

Export each collection with a script using the Admin SDK and insert it with the MongoDB driver. Keep the
Firestore document id as `_id`, turn `Timestamp` into `Date`, references into id strings, and flatten each
subcollection into its own collection:

```ts
for (const snapshot of (await firestore.collection("posts").get()).docs) {
  const { createdAt, author, ...fields } = snapshot.data()
  await db.collection("posts").insertOne({
    _id: snapshot.id,
    ...fields,
    createdAt: createdAt.toDate(),
    authorId: author.id,
  })
  for (const comment of (await snapshot.ref.collection("comments").get()).docs)
    await db
      .collection("comments")
      .insertOne({ _id: comment.id, postId: snapshot.id, ...comment.data() })
}
```

Set `collections.<name>.idType: "string"` in the config for collections that keep Firestore ids.

## 2. Turn Security Rules into policies

```js
match /posts/{post} {
  allow read: if resource.data.published || request.auth.uid == resource.data.authorId;
  allow create: if request.auth.uid == request.resource.data.authorId;
  allow update, delete: if request.auth.uid == resource.data.authorId;
}
```

```ts
import { allow, auth, collection } from "@canopy/policy"

const mine = { authorId: auth("sub") }

export default collection("posts", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("anon", "authenticated").where({ published: true }),
    allow.read("authenticated").where(mine),
    allow.insert("authenticated").check(mine),
    allow.update("authenticated").where(mine).check(mine),
    allow.delete("authenticated").where(mine),
  ],
  immutable: ["authorId"],
})
```

| Rules                                     | Canopy                                            |
| ----------------------------------------- | ------------------------------------------------- |
| `request.auth.uid`                        | `auth("sub")`                                     |
| `request.auth.token.<claim>`              | `auth("<claim>")`                                 |
| `resource.data`                           | The `where` clause (the stored document)          |
| `request.resource.data`                   | The `check` clause (the document after the write) |
| `get()` and `exists()` on other documents | [Context lookups](/recipes/multi-tenant/)         |
| Unchanged fields on update                | `immutable`                                       |

Unlike rules, policies also filter queries: a query returns the documents the user may read instead of failing
when one of them is not readable.

## 3. Keep or move the users

To keep Firebase Authentication, verify its ID tokens:

```ts
import { defineConfig, external } from "@canopy/config"

export default defineConfig({ auth: external.firebase({ projectId: "my-project" }) })
```

To move to built in auth, export the users with their hashes and import them:

```bash
firebase auth:export users.json --format=json --project my-project
canopy auth import users.json --from firebase --env production \
  --hash-key "$SIGNER_KEY" --salt-separator Bw== --rounds 8 --mem-cost 14
```

The hash parameters are in the Firebase console under Authentication, "Password hash parameters". Passwords are
checked with Firebase's scrypt variant at the first sign in and then rehashed. Google, GitHub, Apple and
Microsoft sign ins stay linked to the same accounts. See [importing users](/guides/importing-users/).

## 4. Move clients

```ts
// Firestore
onSnapshot(
  query(
    collection(db, "posts"),
    where("published", "==", true),
    orderBy("createdAt", "desc"),
    limit(20),
  ),
  render,
)

// Canopy
canopy
  .from("posts")
  .find({ published: true })
  .sort({ createdAt: -1 })
  .limit(20)
  .subscribe(({ data }) => render(data))
```

Writes are optimistic in both. `updateDoc(ref, { likes: increment(1) })` becomes
`canopy.update("posts", id, { $inc: { likes: 1 } })`.
