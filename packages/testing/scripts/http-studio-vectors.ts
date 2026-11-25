import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordStudio } from "../../studio/test/conformance/record.ts"

const { values } = parseArgs({
  options: {
    dir: {
      type: "string",
      default: fileURLToPath(new URL("../../../conformance/http/studio/", import.meta.url)),
    },
    check: { type: "boolean", default: false },
  },
})

if (!(await recordStudio(values.dir, values.check))) {
  process.stderr.write("The standalone Studio HTTP oracle differs from a fresh capture\n")
  process.exitCode = 1
}
