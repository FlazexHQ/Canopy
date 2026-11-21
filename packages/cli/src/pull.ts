import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { emitSchemaFile } from "@canopy/schema"
import { MongoClient } from "mongodb"
import { loadCollectionSchemas } from "./collection-schemas.ts"
import { type AppTarget, type Configured, text } from "./invocation.ts"
import { messageOf } from "./output.ts"

/** Lists changed lines in source order, preferring deletions when two alignments tie. */
export function lineDiff(existing: string, generated: string): string[] {
  const lines = /[^\n]*\n|[^\n]+$/g
  const old = existing.replaceAll("\r\n", "\n").match(lines) ?? []
  const next = generated.replaceAll("\r\n", "\n").match(lines) ?? []
  let start = 0
  while (start < old.length && old[start] === next[start]) start++
  let endOld = old.length
  let endNext = next.length
  while (endOld > start && endNext > start && old[endOld - 1] === next[endNext - 1]) {
    endOld--
    endNext--
  }
  const width = endNext - start + 1
  const lengths = new Uint32Array((endOld - start + 1) * width)
  for (let i = endOld - 1; i >= start; i--) {
    for (let j = endNext - 1; j >= start; j--) {
      const k = (i - start) * width + j - start
      lengths[k] =
        old[i] === next[j]
          ? 1 + (lengths[k + width + 1] ?? 0)
          : Math.max(lengths[k + width] ?? 0, lengths[k + 1] ?? 0)
    }
  }
  const changes: string[] = []
  let i = start
  let j = start
  while (i < endOld || j < endNext) {
    const k = (i - start) * width + j - start
    if (i < endOld && j < endNext && old[i] === next[j]) {
      i++
      j++
    } else if (
      i < endOld &&
      (j === endNext || (lengths[k + width] ?? 0) >= (lengths[k + 1] ?? 0))
    ) {
      changes.push(`- ${old[i++]?.replace(/\n$/, "")}`)
    } else {
      changes.push(`+ ${next[j++]?.replace(/\n$/, "")}`)
    }
  }
  return changes
}

/** Inserts a single emitted collection into an editable schema, keeping existing definitions intact. */
export function appendCollection(source: string, generated: string): string {
  const block =
    /^export const (\w+) = collection\([\s\S]*?(?=\n\nexport const schema = defineSchema\()/m.exec(
      generated,
    )
  const binding = block?.[1]
  const declaration =
    /^export const schema = defineSchema\(\s*((?:[\w$]+\s*,\s*)*(?:[\w$]+\s*)?)\)/m
  const builderImport = /^import\s*\{([^{}]*)\}\s*from\s*["']@canopy\/schema\/define["']/m
  const schema = declaration.exec(source)
  const imports = builderImport.exec(source)
  if (!binding || !block || !schema || !imports)
    throw new CanopyError(
      ErrorCode.ConfigInvalid,
      "Unrecognised schema file: expected the schema builder import and export const schema = defineSchema(...)",
    )
  const args = (schema[1] ?? "")
    .split(",")
    .map((arg) => arg.trim())
    .filter(Boolean)
  let name = binding
  for (
    let suffix = 2;
    args.includes(name) ||
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(source);
    suffix++
  ) {
    name = `${binding}${suffix}`
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const definition = block[0]
    .replace(`export const ${binding} =`, `export const ${name} =`)
    .replaceAll("\n", eol)
  const withSchema = source.replace(
    declaration,
    () =>
      `${definition}${eol}${eol}export const schema = defineSchema(${[...args, name].join(", ")})`,
  )
  const builders = (imports[1] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const missing = ["collection", ...(/:\s*t\./.test(definition) ? ["t"] : [])].filter(
    (item) => !builders.includes(item),
  )
  return missing.length === 0
    ? withSchema
    : withSchema.replace(builderImport, () =>
        imports[0].replace(/\{[^{}]*\}/, () => `{ ${[...builders, ...missing].join(", ")} }`),
      )
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

/** Writes the editable schema of an app database or adds one collection to an existing schema. */
export async function pull(call: Configured, app: AppTarget): Promise<number> {
  const { flags, out } = call
  const collection = text(flags, "collection")
  const sample = text(flags, "sample")
  for (const flag of ["collection", "sample", "out"]) {
    if (flags.get(flag) === true || flags.get(flag) === "") {
      out.error(`--${flag} needs a value`)
      return 1
    }
  }
  if (sample !== undefined && !/^[1-9]\d*$/.test(sample)) {
    out.error("--sample needs a positive integer")
    return 1
  }
  const js = flags.has("js")
  const file = text(flags, "out") ?? (js ? "canopy.schema.js" : "canopy.schema.ts")
  const path = resolve(call.cwd, file)
  try {
    await using client = new MongoClient(app.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
    const schemas = await loadCollectionSchemas(
      {
        database: app.database,
        ...(call.dirGiven ? { dir: call.dir } : {}),
        ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
        inferEnums: flags.has("infer-enums"),
      },
      client,
      collection,
    )
    const generated = emitSchemaFile(schemas, { js })
    const existing = await readExisting(path)
    if (existing !== undefined && collection !== undefined) {
      if (existing.includes(`collection(${JSON.stringify(collection)},`)) {
        out.error(
          flags.has("force")
            ? `Replacing one collection is not supported; edit ${collection} by hand in ${file}`
            : `${file} already declares ${collection}`,
        )
        return 1
      }
      await writeFile(path, appendCollection(existing, generated))
      out.log(`added ${collection} to ${file}`)
      return 0
    }
    if (existing !== undefined) {
      if (existing.replaceAll("\r\n", "\n") === generated) {
        out.log(`${file} is up to date`)
        return 0
      }
      if (!flags.has("force")) {
        out.error(`${file} was edited; pass --force to replace it`)
        for (const change of lineDiff(existing, generated)) out.error(change)
        return 1
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, generated, { flag: existing === undefined ? "wx" : "w" })
    out.log(`wrote ${file} (${schemas.length} collections)`)
    return 0
  } catch (error: unknown) {
    out.error(messageOf(error))
    return 1
  }
}
