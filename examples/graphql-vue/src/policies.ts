import { allow, auth, collection } from "@canopy/policy"

/** The topics posts belong to. Everyone signed in reads them; nobody writes them through the API. */
export const topics = collection("topics", {
  exposed: true,
  policies: [allow.read("authenticated").named("read topics")],
})

/**
 * Posts are public to everyone signed in. A post is created by its owner only, carries only these fields,
 * and its owner and topic never change.
 */
export const posts = collection("posts", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").named("read posts"),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub") })
      .named("create own"),
    allow
      .delete("authenticated")
      .where({ ownerId: auth("sub") })
      .named("delete own"),
  ],
  fields: { write: { default: { only: ["title", "topicId", "ownerId"] } } },
  immutable: ["ownerId", "topicId"],
})
