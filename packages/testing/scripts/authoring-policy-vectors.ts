import { mkdir, readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import {
  recordAuthoringPolicy,
  recordAuthoringPublishing,
} from "../../policy/test/conformance/authoring/record.ts"

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } })
const directory = new URL("../../../conformance/authoring/policy/", import.meta.url)
const outputs = [
  ["vectors.json", await recordAuthoringPolicy()],
  ["publishing.json", recordAuthoringPublishing()],
] as const
if (!values.check) await mkdir(directory, { recursive: true })
for (const [name, output] of outputs) {
  const file = new URL(name, directory)
  if (values.check) {
    if ((await readFile(file, "utf8")) !== output) {
      process.stderr.write(
        `Policy authoring fixture ${name} differs. Run bun run vectors:authoring-policy.\n`,
      )
      process.exitCode = 1
    }
  } else {
    await writeFile(file, output)
  }
}
