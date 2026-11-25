import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { MongoClient } from "mongodb"
import { recordTypegen } from "../../cli/test/conformance/typegen/record.ts"

const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    check: { type: "boolean", default: false },
    dir: {
      type: "string",
      default: fileURLToPath(new URL("../../../conformance/typegen", import.meta.url)),
    },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a MongoDB replica set")

await using client = new MongoClient(values.uri, { serverSelectionTimeoutMS: 10_000 })
const differing = await recordTypegen({
  dir: values.dir,
  check: values.check,
  mongo: { client, uri: values.uri },
})
if (differing.length > 0) {
  process.stderr.write(`Vector files differ: ${differing.join(", ")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(values.check ? "conformance/typegen is current\n" : `Wrote ${values.dir}\n`)
}
