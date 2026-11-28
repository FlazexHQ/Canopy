import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { recordConfigAuthoring } from "../../config/test/authoring-record.ts"
import { recordSchemaAuthoring } from "../../schema/test/authoring-record.ts"

const root = new URL("../../../conformance/authoring/", import.meta.url)
const { values } = parseArgs({ options: { check: { type: "boolean" } } })

async function save(name: string, vectors: unknown): Promise<void> {
  const output = new URL(name, root)
  const text = `${JSON.stringify(vectors, null, 2)}\n`
  if (values.check) {
    if ((await readFile(output, "utf8")) !== text) throw new Error(`${name} differs`)
  } else await writeFile(output, text)
}

const [config, collections] = await Promise.all([recordConfigAuthoring(), recordSchemaAuthoring()])
await Promise.all([save("config/vectors.json", config), save("schema/vectors.json", collections)])
process.stdout.write(
  values.check
    ? "Authoring vectors are current\n"
    : "Wrote config and collection authoring vectors\n",
)
