import type { Db } from "mongodb"

/**
 * The shape of a todo, enforced by MongoDB. `canopy gen types` reads this validator to write
 * `web/canopy.gen.ts`, so the React app is typed by the same schema the database enforces.
 */
const todoValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "title", "done", "shared", "ownerId", "v", "createdAt"],
    additionalProperties: false,
    properties: {
      _id: { bsonType: "objectId" },
      title: { bsonType: "string", minLength: 1 },
      done: { bsonType: "bool" },
      shared: { bsonType: "bool" },
      ownerId: { bsonType: "string" },
      v: { bsonType: "int", minimum: 0 },
      createdAt: { bsonType: "date" },
    },
  },
}

/** Creates the `todos` collection with its validator, or brings the validator of an existing one up to date. */
export async function ensureTodos(db: Db): Promise<void> {
  const exists =
    (await db.listCollections({ name: "todos" }, { nameOnly: true }).toArray()).length > 0
  if (exists) await db.command({ collMod: "todos", validator: todoValidator })
  else await db.createCollection("todos", { validator: todoValidator })
}
