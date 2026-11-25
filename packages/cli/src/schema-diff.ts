import { existsSync, watch } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { PolicyEngine, Role } from "@canopy/policy"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import {
  type CollectionSchema,
  diffSchemas,
  restrictShape,
  type SchemaDifference,
  type Shape,
  toValidator,
} from "@canopy/schema"
import { collectionSchemaDocument } from "canopy.js/emit"
import { type Db, MongoClient } from "mongodb"
import { loadCollectionSchemas } from "./collection-schemas.ts"
import { appTarget, type Configured } from "./invocation.ts"
import { confirmed, messageOf, type Output } from "./output.ts"

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function isSchema(value: unknown): boolean {
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

/** Finds the project's schema declaration, preferring TypeScript. */
export function findSchemaFile(cwd: string): string | undefined {
  return ["canopy.schema.ts", "canopy.schema.js"].find((name) => existsSync(resolve(cwd, name)))
}

function schemaFile(call: Configured): string {
  const option = call.flags.get("file")
  if (option === true || option === "")
    throw new CanopyError(ErrorCode.ConfigInvalid, "--file needs a path")
  const file = option ?? findSchemaFile(call.cwd)
  if (file === undefined)
    throw new CanopyError(
      ErrorCode.ConfigInvalid,
      "Cannot find canopy.schema.ts or canopy.schema.js",
    )
  return file
}

let version = 0

async function readDeclared(file: string, cwd: string, fresh = false) {
  try {
    const path = resolve(cwd, file)
    const url = pathToFileURL(path).href
    // Bun preserves the version query on absolute paths when reloading a module.
    const specifier = fresh && "Bun" in globalThis ? path : url
    const module: unknown = await import(fresh ? `${specifier}?v=${++version}` : url)
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
    return collectionSchemaDocument(module.schema).collections as readonly CollectionSchema[]
  } catch (error: unknown) {
    throw new CanopyError(ErrorCode.ConfigInvalid, `Cannot load ${file}: ${messageOf(error)}`, {
      cause: error,
    })
  }
}

type SchemaOptions = Parameters<typeof loadCollectionSchemas>[0]

function fieldPaths(shape: Shape): Set<string> {
  const paths = new Set<string>()
  function visit(value: Shape, prefix: string): void {
    if (value.kind === "array") visit(value.items, prefix)
    if (value.kind === "union") for (const member of value.of) visit(member, prefix)
    if (value.kind === "object") {
      for (const [name, field] of Object.entries(value.fields)) {
        const path = prefix === "" ? name : `${prefix}.${name}`
        paths.add(path)
        visit(field.shape, path)
      }
    }
  }
  visit(shape, "")
  return paths
}

/** Reports declared paths excluded by a role's read and insert permissions. */
export function roleReport(
  declared: readonly CollectionSchema[],
  engine: PolicyEngine,
  role: string,
): string[] {
  const base = role === Role.Anon || role === Role.Authenticated || role === Role.Service
  const ctx = {
    roles: new Set(base ? [role] : [Role.Authenticated, role]),
    claims: null,
    now: new Date(0),
  }
  const lines: string[] = []
  for (const { name, shape } of [...declared].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const paths = [...fieldPaths(shape)].sort()
    const restrictions: string[] = []
    if (engine.hasGrant(name, "read", ctx)) {
      const visible = fieldPaths(restrictShape(shape, engine.readable(name, ctx)))
      const hidden = paths.filter((path) => !visible.has(path))
      if (hidden.length > 0) restrictions.push(`  cannot read: ${hidden.join(", ")}`)
    } else {
      restrictions.push("  cannot read the collection")
    }
    const writable = engine.hasGrant(name, "insert", ctx)
      ? fieldPaths(restrictShape(shape, engine.writable(name, "insert", ctx)))
      : new Set<string>()
    const denied = paths.filter((path) => !writable.has(path))
    if (denied.length > 0) restrictions.push(`  cannot write: ${denied.join(", ")} (on insert)`)
    if (restrictions.length > 0) lines.push(`role ${role} on ${name}:`, ...restrictions)
  }
  return lines.length > 0 ? lines : [`role ${role} can read and write every declared field`]
}

async function compareDeclared(
  declared: readonly CollectionSchema[],
  client: MongoClient,
  options: SchemaOptions,
): Promise<SchemaDifference[]> {
  return diffSchemas(declared, await loadCollectionSchemas(options, client))
}

/** Reads the current schema declaration and compares it to MongoDB. */
export async function schemaDrift(
  file: string,
  cwd: string,
  client: MongoClient,
  options: SchemaOptions,
): Promise<SchemaDifference[]> {
  return compareDeclared(await readDeclared(file, cwd, true), client, options)
}

/** Formats a warning or recovery when the set of reported differences changes. */
export function driftReport(
  file: string,
  database: string,
  previous: ReadonlySet<string>,
  differences: readonly SchemaDifference[],
) {
  const messages = new Set(differences.map(({ message }) => message))
  const errors: string[] = []
  const logs: string[] = []
  if (messages.size === 0) {
    if (previous.size > 0) logs.push(`schema  ${file} matches ${database} again`)
  } else if (
    messages.size !== previous.size ||
    [...messages].some((message) => !previous.has(message))
  ) {
    errors.push(`schema  ${file} differs from ${database}:`)
    for (const message of messages) errors.push(`  ${message}`)
    errors.push(`schema  run canopy schema push or edit ${file}`)
  }
  return { messages, errors, logs }
}

/** Reports changes in schema drift until the signal aborts. */
export async function watchSchemaDrift(
  options: { file: string; cwd: string; mongodbUri: string; database: string },
  out: Output,
  signal: AbortSignal,
): Promise<number> {
  const { cwd, file, database } = options
  if (signal.aborted) return 0
  try {
    await using client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
    await client.connect()
    if (signal.aborted) return 0
    const events = ["create", "modify", "drop", "rename", "dropDatabase"]
    await using stream = client
      .db(database)
      .watch([{ $match: { operationType: { $in: events } } }], {
        showExpandedEvents: true,
      })
    let previous = new Set<string>()
    let queue = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      queue = queue.then(async () => {
        if (signal.aborted) return
        try {
          const differences = await schemaDrift(file, cwd, client, { database })
          if (signal.aborted) return
          const report = driftReport(file, database, previous, differences)
          for (const line of report.errors) out.error(line)
          for (const line of report.logs) out.log(line)
          previous = report.messages
        } catch (error: unknown) {
          out.error(`schema  ${messageOf(error)}`)
        }
      })
    }
    const soon = (): void => {
      if (signal.aborted) return
      clearTimeout(timer)
      timer = setTimeout(run, 200)
    }
    const path = resolve(cwd, file)
    const watcher = watch(dirname(path), (_event, name) => {
      if (name === null || name === basename(path)) soon()
    })
    try {
      watcher.on("error", (error: unknown) =>
        out.error(`schema  file watcher: ${messageOf(error)}`),
      )
      stream.on("error", (error: unknown) =>
        out.error(`schema  change stream: ${messageOf(error)}`),
      )
      stream.on("change", soon)
      run()
      await new Promise<void>((done) => {
        if (signal.aborted) done()
        else signal.addEventListener("abort", () => done(), { once: true })
      })
    } finally {
      watcher.close()
      stream.off("change", soon)
      clearTimeout(timer)
      await queue
    }
    return 0
  } catch (error: unknown) {
    out.error(`schema  ${messageOf(error)}`)
    return 1
  }
}

async function push(
  call: Configured,
  db: Db,
  declared: readonly CollectionSchema[],
): Promise<number> {
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
    const file = schemaFile(call)
    const declared = await readDeclared(file, call.cwd)
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
    const role = flags.get("role")
    let report: string[] = []
    if (role !== undefined) {
      if (role === true || role.trim() === "") {
        out.error("--role needs a role name")
        return 1
      }
      if (!call.dirGiven) {
        out.error("--role needs a policy directory from --dir or policies.dir")
        return 1
      }
      try {
        const set = await directoryPolicies(call.dir).load()
        if (set.collections.size === 0) {
          out.error(`No collection policies found in ${call.dir}`)
          return 1
        }
        report = roleReport(declared, new PolicyEngine(set), role)
      } catch (error: unknown) {
        out.error(`Cannot load policies from ${call.dir}: ${messageOf(error)}`)
        return 1
      }
    }
    const app = appTarget(call)
    if (app === undefined) return 1
    await using client = new MongoClient(app.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
    if (call.name === "schema push") return await push(call, client.db(app.database), declared)
    const differences = await compareDeclared(declared, client, {
      database: app.database,
      ...(call.dirGiven ? { dir: call.dir } : {}),
      ...(sample === undefined ? {} : { sampleSize: Number(sample) }),
      inferEnums: flags.has("infer-enums"),
    })
    if (differences.length === 0) {
      out.log(`no drift between ${file} and ${app.database}`)
    } else {
      for (const difference of differences) out.error(difference.message)
      out.error(`${differences.length} differences; edit ${file} or run canopy schema push`)
    }
    for (const line of report) out.log(line)
    return differences.length === 0 ? 0 : 1
  } catch (error: unknown) {
    out.error(messageOf(error))
    return 1
  }
}
