import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { MongoClient } from "mongodb"
import { generateVectors } from "./generate.ts"
import { pullVectors } from "./pull.ts"

/** Writes the type generation or CLI oracle, or returns its filename when it differs. */
export async function recordTypegen(options: {
  readonly dir: string
  readonly check: boolean
  readonly mongo?: { readonly client: MongoClient; readonly uri: string }
}): Promise<string[]> {
  const { dir, check, mongo } = options
  const vectors = {
    "generate.json": await generateVectors(),
    ...(mongo === undefined ? {} : { "pull.json": await pullVectors(mongo.client, mongo.uri) }),
  }
  const differing: string[] = []
  for (const [name, value] of Object.entries(vectors)) {
    const path = join(dir, name)
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (check) {
      if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== text) differing.push(name)
    } else {
      await mkdir(dir, { recursive: true })
      await writeFile(path, text)
    }
  }
  return differing
}
