import { collection, defineSchema, t } from "@canopy/schema/define"

export const schema = defineSchema(
  collection("messages", {
    authorId: t.string(),
    body: t.string(),
    createdAt: t.date(),
  }),
)
declare module "@canopy/client" {
  interface Register {
    schema: typeof schema
  }
}
