import { toStored } from "@canopy/policy"
import { MongoClient } from "mongodb"
import { todos } from "../src/policies.ts"
import { ensureTodos } from "../src/schema.ts"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
if (!uri) throw new Error("Missing CANOPY_TEST_MONGODB_URI")
await using mongo = new MongoClient(uri)
await ensureTodos(mongo.db(process.env["CANOPY_DB"] ?? "app"))
const meta = mongo.db(process.env["CANOPY_META_DB"] ?? "canopy")
await meta.collection<{ _id: string }>("policies").insertOne(toStored(todos, { version: 1 }))
