import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { type CollectionSchema, diffSchemas, toValidator } from "@canopy/schema"
import { type SchemaDefinition, toCollectionSchemas } from "@canopy/schema/define"
import { type Db, MongoClient } from "mongodb"
import { loadCollectionSchemas } from "./gen-types.ts"
import { appTarget, type Configured } from "./invocation.ts"
import { confirmed, messageOf } from "./output.ts"

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function isSchema(value: unknown): value is SchemaDefinition {
  return (
    plainObject(value) &&
    Object.values(value).every(
      (entry) =>
        plainObject(entry) &&
        typeof entry["name"] === "string" &&
        plainObject(entry["shape"]) &&
        entry["shape"]["kind"] === "object" &&
        plainObject(entry["shape"]["fields"]),
    )
  )
}

async function readDeclared(call: Configured) {
  const option = call.flags.get("file")
  if (option === true || option === "")
    throw new CanopyError(ErrorCode.ConfigInvalid, "--file needs a path")
  const file =
    option ??
    ["canopy.schema.ts", "canopy.schema.js"].find((name) => existsSync(resolve(call.cwd, name)))
  if (file === undefined)
    throw new CanopyError(
      ErrorCode.ConfigInvalid,
      "Cannot find canopy.schema.ts or canopy.schema.js",
    )
  try {
    const module: unknown = await import(pathToFileURL(resolve(call.cwd, file)).href)
    if (
      typeof module !== "object" ||
      module === null ||
      !("schema" in module) ||
      !isSchema(module.schema)
    )
      throw new CanopyError(
        ErrorCode.ConfigInvalid,
        "Expected a schema export containing collection definitions with a name and an object shape",
      )
    return { file, declared: toCollectionSchemas(module.schema) }
  } catch (error: unknown) {
    throw new CanopyError(ErrorCode.ConfigInvalid, `Cannot load ${file}: ${messageOf(error)}`, {
      cause: error,
    })
  }
}

async function push(call: Configured, db: Db, declared: CollectionSchema[]): Promise<number> {
  const { out } = call
  const changes = []
  for (const { name, shape } of declared) {
    const validator = { $jsonSchema: toValidator(shape) }
    await using cursor = db.listCollections({ name }, { nameOnly: false })
    const info = await cursor.next()
    if (info !== null && isDeepStrictEqual(info.options?.["validator"], validator)) continue
    changes.push({ name, validator, create: info === null })
  }
  if (changes.length === 0) {
    out.log("validators are up to date")
    return 0
  }
  for (const { name, create } of changes)
    out.log(create ? `create ${name}` : `update validator of ${name}`)
  if (
    !(await confirmed(out, `Apply these validators to ${db.databaseName}?`, call.flags.has("yes")))
  )
    return 1
  for (const { name, validator, create } of changes) {
    if (create) await db.createCollection(name, { validator })
    else await db.command({ collMod: name, validator })
    out.log(create ? `created ${name}` : `updated validator of ${name}`)
  }
  return 0
}

/** Compares a project's declared schemas with MongoDB or applies their validators after confirmation. */
export async function runSchema(call: Configured): Promise<number> {
  const { flags, out } = call
  try {
    const { file, declared } = await readDeclared(call)
    const sample = flags.get("sample")
    if (
      sample !== undefined &&
      (typeof sample !== "string" ||
        !/^[1-9]\d*$/.test(sample) ||
        !Number.isSafeInteger(Number(sample)))
    ) {
      out.error("--sample needs a positive integer")
      return 1
    }
    const app = appTarget(call)
    if (app === undefined) return 1
    await using client = new MongoClient(app.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
    if (call.name === "schema push") return await push(call, client.db(app.database), declared)
    const actual = await loadCollectionSchemas(
      {
        database: app.database,
        ...(call.dirGiven ? { dir: call.dir } : {}),
        ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
        inferEnums: flags.has("infer-enums"),
      },
      client,
    )
    const differences = diffSchemas(declared, actual)
    if (differences.length === 0) {
      out.log(`no drift between ${file} and ${app.database}`)
      return 0
    }
    for (const difference of differences) out.error(difference.message)
    out.error(`${differences.length} differences; edit ${file} or run canopy schema push`)
    return 1
  } catch (error: unknown) {
    out.error(messageOf(error))
    return 1
  }
}
