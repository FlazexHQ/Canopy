import { MongoClient } from "mongodb"
import { ApiKeys } from "../../src/api-keys.ts"

const uri = process.env["CANOPY_TEST_MONGODB_URI"]
const database = process.argv[2]
if (uri === undefined || database === undefined) process.exit(1)

await using mongo = await MongoClient.connect(uri)
const keys = new ApiKeys(mongo.db(database))
const { key, info } = await keys.create({ kind: "secret", name: "wire test", createdBy: "test" })
process.stdout.write(JSON.stringify({ key, id: info.id }))
