import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { recordGraphqlSchemas } from "../../graphql/test/conformance/schema/record.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    out: { type: "string", default: resolve(root, "conformance/graphql/schema.json") },
    check: { type: "boolean", default: false },
  },
})

const differs = await recordGraphqlSchemas({ file: values.out, check: values.check })
if (values.check) {
  if (differs) {
    process.stderr.write(`${values.out} differs from a fresh computation\n`)
    process.exit(1)
  }
  process.stdout.write("conformance/graphql/schema.json is current\n")
} else {
  process.stdout.write(`Wrote ${values.out}\n`)
}
