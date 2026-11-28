import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { MongoClient } from "mongodb"
import { recordMigrations } from "../../server/test/conformance/migrations/record.ts"

const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    dir: {
      type: "string",
      default: fileURLToPath(new URL("../../../conformance/migrations", import.meta.url)),
    },
    check: { type: "boolean", default: false },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a MongoDB replica set")

await using client = new MongoClient(values.uri, { serverSelectionTimeoutMS: 10_000 })
await client.connect()
const differing = await recordMigrations({ client, dir: values.dir, check: values.check })
if (differing.length > 0) {
  process.stderr.write(`Vector files differ: ${differing.join(", ")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    values.check ? "conformance/migrations is current\n" : `Wrote ${values.dir}\n`,
  )
}
