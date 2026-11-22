import type {} from "canopy.js"
import { collection, defineSchema, t } from "canopy.js/schema"

/**
 * The todos collection, declared once. The client, the React hooks and the helper types (`Doc<"todos">`,
 * `Id<"todos">`) are typed from it, and the server test checks it against the collection's validator.
 */
const todos = collection("todos", {
  title: t.string(),
  done: t.bool(),
  shared: t.bool(),
  ownerId: t.string(),
  v: t.int(),
  createdAt: t.date(),
})

export const schema = defineSchema(todos)

declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}
