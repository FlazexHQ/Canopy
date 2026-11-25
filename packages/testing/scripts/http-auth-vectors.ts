import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { MongoClient } from "mongodb"
import { recordAuth } from "../../auth-builtin/test/conformance/record.ts"

/**
 * Records `conformance/http/auth`: every `/auth/v1` flow of built in auth on a fake clock with seeded
 * randomness, mail captured and the identity providers mocked, with the documents each case leaves in
 * `canopy_auth`, `canopy.audit_log` and `canopy.revocations`. Each case runs twice under two seeds and what
 * differs between the runs is replaced by placeholders. Then proves the `canopy_auth` fixture database of
 * `conformance/auth/documents` (written first when missing, or with `--rewrite-documents`). With `--check`
 * nothing is written and the exit code is 1 when a file would change or a proof fails. `--group` records
 * only the named groups (repeatable).
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/http-auth-vectors.ts [--uri <replica set>] [--dir <folder>] [--documents <folder>] [--rewrite-documents] [--check] [--group <name>]
 *
 * `--uri` defaults to `CANOPY_TEST_MONGODB_URI`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    dir: { type: "string", default: resolve(root, "conformance/http/auth") },
    documents: { type: "string", default: resolve(root, "conformance/auth/documents") },
    "rewrite-documents": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    group: { type: "string", multiple: true },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a MongoDB replica set")

const client = new MongoClient(values.uri, { serverSelectionTimeoutMS: 10_000 })
await client.connect()
try {
  const differing = await recordAuth({
    client,
    dir: values.dir,
    documentsDir: values.documents,
    rewriteDocuments: values["rewrite-documents"],
    check: values.check,
    ...(values.group === undefined ? {} : { groups: values.group }),
  })
  if (differing.length > 0) {
    process.stderr.write(`These files differ or proofs failed:\n  ${differing.join("\n  ")}\n`)
    process.exitCode = 1
  } else if (values.check) process.stdout.write("conformance/http/auth is current\n")
  else process.stdout.write(`Wrote ${values.dir}\n`)
} finally {
  await client.close()
}
