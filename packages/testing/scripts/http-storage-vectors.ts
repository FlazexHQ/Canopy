import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { MongoClient } from "mongodb"
import { recordStorage } from "../../storage/test/conformance/record.ts"

/**
 * Records `conformance/http/storage`: the request and response pairs of the Storage HTTP endpoint, with the
 * documents each mutation case leaves, served by the TypeScript Storage handler against a scratch
 * database on a MongoDB replica set and a fresh local backend for each case. With `--check` nothing is
 * written and the exit code is 1 when a file would change.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/http-storage-vectors.ts [--uri <replica set>] [--dir <folder>] [--check]
 *
 * `--uri` defaults to `CANOPY_TEST_MONGODB_URI`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    dir: { type: "string", default: resolve(root, "conformance/http/storage") },
    check: { type: "boolean", default: false },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a MongoDB replica set")

const client = new MongoClient(values.uri, { serverSelectionTimeoutMS: 10_000 })
await client.connect()
try {
  const differing = await recordStorage({ client, dir: values.dir, check: values.check })
  if (values.check) {
    if (differing.length > 0) {
      process.stderr.write(`These files differ from a fresh recording: ${differing.join(", ")}\n`)
      process.exitCode = 1
    } else process.stdout.write("conformance/http/storage is current\n")
  } else process.stdout.write(`Wrote ${values.dir}\n`)
} finally {
  await client.close()
}
