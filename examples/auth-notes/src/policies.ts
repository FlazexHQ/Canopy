import { allow, auth, collection } from "@canopy/policy"

/**
 * Notes are private: a signed in user reads, writes and deletes only the notes whose `ownerId` is their
 * own user id, and cannot create a note for someone else or hand one over.
 */
export const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("read own"),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub") })
      .named("create own"),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") })
      .named("edit own"),
    allow
      .delete("authenticated")
      .where({ ownerId: auth("sub") })
      .named("delete own"),
  ],
  fields: { write: { default: { only: ["text", "ownerId", "createdAt"] } } },
  immutable: ["ownerId", "createdAt"],
})
