import type {} from "canopy.js"
import { collection, defineSchema, t } from "canopy.js/schema"

/**
 * The notes collection, declared once. The client generates each note's ObjectId from it, and
 * `Doc<"notes">` types the documents the page renders.
 */
const notes = collection("notes", {
  text: t.string(),
  ownerId: t.string(),
  createdAt: t.date(),
})

export const schema = defineSchema(notes)

declare module "canopy.js" {
  interface Register {
    schema: typeof schema
  }
}
