import type { Db } from "mongodb"

/** The topics a post can belong to, kept up to date at every start. */
const TOPICS = [
  { _id: "news", name: "News" },
  { _id: "ideas", name: "Ideas" },
  { _id: "help", name: "Help" },
] as const

const validators = {
  topics: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "name"],
      additionalProperties: false,
      properties: { _id: { bsonType: "string" }, name: { bsonType: "string" } },
    },
  },
  posts: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "title", "topicId", "ownerId"],
      additionalProperties: false,
      properties: {
        _id: { bsonType: "objectId" },
        title: { bsonType: "string", minLength: 1, maxLength: 200 },
        topicId: { enum: TOPICS.map((topic) => topic._id) },
        ownerId: { bsonType: "string" },
      },
    },
  },
}

/**
 * Creates the collections with their validators (or updates the validators) and the topics. GraphQL types
 * the fields from these validators, so they exist before the first post does.
 */
export async function ensureSchema(db: Db): Promise<void> {
  for (const [name, validator] of Object.entries(validators)) {
    const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0
    if (exists) await db.command({ collMod: name, validator })
    else await db.createCollection(name, { validator })
  }
  const topics = db.collection<{ _id: string; name: string }>("topics")
  for (const topic of TOPICS)
    await topics.updateOne({ _id: topic._id }, { $set: { name: topic.name } }, { upsert: true })
}
