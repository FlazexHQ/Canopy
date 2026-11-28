import { collection, defineSchema, t } from "@canopy/schema/define"

export const schema = defineSchema(collection("notes", { ownerId: t.string(), title: t.string() }))
