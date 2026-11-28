import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordCli } from "../../cli/test/conformance/cli/record.ts"

const { values } = parseArgs({
  options: {
    uri: { type: "string", default: process.env["CANOPY_TEST_MONGODB_URI"] },
    check: { type: "boolean", default: false },
  },
})
if (values.uri === undefined) throw new Error("Pass --uri or set CANOPY_TEST_MONGODB_URI")

const dir = fileURLToPath(new URL("../../../conformance/cli", import.meta.url))
const differing = await recordCli(dir, values.uri, values.check)
if (differing.length > 0) {
  process.stderr.write(`CLI vectors differ: ${differing.join(", ")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(values.check ? "conformance/cli is current\n" : "Wrote conformance/cli\n")
}
