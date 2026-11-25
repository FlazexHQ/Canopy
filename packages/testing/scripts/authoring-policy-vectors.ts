import { mkdir, readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { recordAuthoringPolicy } from "../../policy/test/conformance/authoring/record.ts"

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } })
const directory = new URL("../../../conformance/authoring/policy/", import.meta.url)
const file = new URL("vectors.json", directory)
const output = await recordAuthoringPolicy()
if (values.check) {
  if ((await readFile(file, "utf8")) !== output) {
    process.stderr.write("Policy authoring vectors differ. Run bun run vectors:authoring-policy.\n")
    process.exitCode = 1
  }
} else {
  await mkdir(directory, { recursive: true })
  await writeFile(file, output)
}
