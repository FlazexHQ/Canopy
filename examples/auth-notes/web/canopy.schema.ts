import type {} from "@canopy/client"
import { collection, defineSchema, t } from "@canopy/schema/define"

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

declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
