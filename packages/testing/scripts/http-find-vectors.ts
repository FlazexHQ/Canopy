import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordFind, recordGroups } from "../../rest/test/conformance/find/record.ts"
import { READ_GROUPS } from "../../rest/test/conformance/reads/cases.ts"

/**
 * Records the request and response pairs of the Data API read routes for the Rust data plane:
 * `conformance/http/find` for `find`, and `conformance/http/reads` for `_count`, `_distinct` and `_aggregate`.
 * The TypeScript REST handler is built from the committed fixture, every case is served against a scratch
 * database on a MongoDB replica set, and the fixture and one file per group of cases are written in each
 * folder. With `--check` nothing is written and the exit code is 1 when a file would change. `--dir` is the
 * `conformance/http` folder.
 *
 *   bun --conditions=@canopy/source packages/testing/scripts/http-find-vectors.ts [--uri <replica set>] [--dir <folder>] [--check]
 *
 * `--uri` defaults to `CANOPY_TEST_MONGODB_URI`. The recording is deterministic except for the volatile values
 * listed in `conformance/README.md`, which the files hold as placeholders.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    dir: { type: "string", default: resolve(root, "conformance/http") },
    check: { type: "boolean", default: false },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a MongoDB replica set")

const options = { uri: values.uri, check: values.check }
const differing = [
  ...(await recordFind({ ...options, dir: resolve(values.dir, "find") })).map(
    (name) => `find/${name}`,
  ),
  ...(await recordGroups({ ...options, dir: resolve(values.dir, "reads") }, READ_GROUPS)).map(
    (name) => `reads/${name}`,
  ),
]
if (values.check) {
  if (differing.length > 0) {
    process.stderr.write(`These files differ from a fresh recording: ${differing.join(", ")}\n`)
    process.exit(1)
  }
  process.stdout.write("conformance/http/find and conformance/http/reads are current\n")
} else {
  process.stdout.write(`Wrote ${values.dir}/find and ${values.dir}/reads\n`)
}
