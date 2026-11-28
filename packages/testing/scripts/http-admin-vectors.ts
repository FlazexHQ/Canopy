import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordAdmin } from "../../server/test/conformance/admin/record.ts"

const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    dir: {
      type: "string",
      default: fileURLToPath(new URL("../../../conformance/http/admin/", import.meta.url)),
    },
    check: { type: "boolean", default: false },
  },
})
if (values.uri === undefined)
  throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI to a scratch replica set")
const differing = await recordAdmin(values.uri, values.dir, values.check)
if (differing.length > 0) {
  process.stderr.write(`The admin HTTP oracle differs in: ${differing.join(", ")}\n`)
  process.exitCode = 1
}
