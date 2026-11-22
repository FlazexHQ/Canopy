import { collection, defineSchema, t } from "canopy.js/schema"

export const todos = collection("todos", {
  title: t.string(),
  done: t.bool(),
  ownerId: t.string(),
  tags: t.array(t.string()).optional(),
})

export const schema = defineSchema(todos)

declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}
