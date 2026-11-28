import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { MongoClient } from "mongodb"

/** Options shared by the server oracle recorders. */
export interface VectorOptions {
  readonly client: MongoClient
  readonly dir: string
  readonly check?: boolean
}

/** Writes a vector file, or reports its name when a fresh recording differs. */
export async function vectorFile(
  { dir, check }: VectorOptions,
  name: string,
  value: unknown,
): Promise<string[]> {
  const path = join(dir, name)
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (check === true) {
    const current = await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    return current?.replaceAll("\r\n", "\n") === content ? [] : [name]
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path, content)
  return []
}
