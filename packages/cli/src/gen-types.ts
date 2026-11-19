import { watch } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { PolicyEngine, type RequestContext, Role } from "@canopy/policy"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import { loadSchema } from "@canopy/rest"
import { type CollectionSchema, generateTypes, restrictShape } from "@canopy/schema"
import { MongoClient } from "mongodb"
import type { Output } from "./commands.ts"

/** Options of `canopy gen types`. */
export interface GenTypesOptions {
  readonly mongodbUri: string
  readonly database: string
  /** The policy directory. Its exposed collections are typed; without one, every collection is. */
  readonly dir?: string
  /** Type for this role: fields it cannot read become optional. */
  readonly role?: string
  /** The file to write or, with `check`, to compare. */
  readonly out: string
  /** Fail when `out` differs from what would be generated, instead of writing it. */
  readonly check?: boolean
  /** Turn low cardinality string fields into literal unions. */
  readonly inferEnums?: boolean
  /** Documents sampled per collection without a validator. */
  readonly sampleSize?: number
}

function contextFor(role: string): RequestContext {
  const base = role === Role.Anon || role === Role.Authenticated || role === Role.Service
  return {
    roles: new Set(base ? [role] : [Role.Authenticated, role]),
    claims: null,
    now: new Date(0),
  }
}

/** Loads selected collection schemas, optionally applying a role's field visibility. */
export async function loadCollectionSchemas(
  options: Pick<GenTypesOptions, "database" | "dir" | "sampleSize" | "inferEnums" | "role">,
  client: MongoClient,
  collection?: string,
): Promise<CollectionSchema[]> {
  const set =
    options.dir === undefined || collection !== undefined
      ? undefined
      : await directoryPolicies(options.dir)
          .load()
          .catch((error: unknown) => {
            throw new CanopyError(
              ErrorCode.ConfigInvalid,
              `policies do not load: ${messageOf(error)}`,
              { cause: error },
            )
          })
  const db = client.db(options.database)
  const exposed = [...(set?.collections.values() ?? [])].filter((def) => def.exposed)
  const names =
    exposed.length > 0
      ? exposed.map((def) => def.collection)
      : (
          await db
            .listCollections(collection === undefined ? {} : { name: collection }, {
              nameOnly: true,
            })
            .toArray()
        )
          .map((info) => info.name)
          .filter((name) => collection !== undefined || !name.startsWith("system."))
  if (collection !== undefined && names.length === 0)
    throw new CanopyError(
      ErrorCode.NotFound,
      `Collection ${collection} does not exist in the database`,
    )
  const engine = set === undefined ? undefined : new PolicyEngine(set)
  const ctx = options.role === undefined ? undefined : contextFor(options.role)
  const schemas: CollectionSchema[] = []
  for (const name of names.sort()) {
    const schema = await loadSchema(db, name, {
      ...(options.sampleSize === undefined ? {} : { sampleSize: options.sampleSize }),
      infer: { enums: options.inferEnums === true },
    })
    schemas.push(
      engine === undefined || ctx === undefined
        ? schema
        : { ...schema, shape: restrictShape(schema.shape, engine.readable(name, ctx), "optional") },
    )
  }
  return schemas
}

async function generate(
  options: GenTypesOptions,
  client: MongoClient,
): Promise<{ readonly text: string; readonly count: number }> {
  const schemas = await loadCollectionSchemas(options, client)
  const text = generateTypes(schemas, {
    ...(options.role === undefined
      ? {}
      : { note: `Fields the ${options.role} role cannot read are optional.` }),
  })
  return { text, count: schemas.length }
}

async function current(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replaceAll("\r\n", "\n")
  } catch {
    return undefined
  }
}

/** Writes `text` to `path` unless it already holds it. Returns whether the file changed. */
async function writeIfChanged(path: string, text: string): Promise<boolean> {
  if ((await current(path)) === text) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return true
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `canopy gen types`: writes the `Database` interface from the collection schemas (validator, then
 * config, then inference). With `check`, exits 1 when the committed file is stale.
 */
export async function genTypes(options: GenTypesOptions, out: Output): Promise<number> {
  out.log("canopy gen types is deprecated: run canopy pull to write a canopy.schema.ts")
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    const { text, count } = await generate(options, client)
    if (options.check === true) {
      if ((await current(options.out)) === text) {
        out.log(`${options.out} is up to date (${count} collections)`)
        return 0
      }
      out.error(`${options.out} is out of date; run canopy gen types`)
      return 1
    }
    await writeIfChanged(options.out, text)
    out.log(`wrote ${options.out} (${count} collections)`)
    return 0
  } catch (error: unknown) {
    out.error(`error  ${messageOf(error)}`)
    return 1
  } finally {
    await client.close()
  }
}

/** The change stream events after which the schemas may differ. */
const SCHEMA_EVENTS = new Set(["create", "modify", "drop", "rename", "dropDatabase"])

/**
 * `canopy gen types --watch`: generates the types, then again whenever a policy file changes or the
 * database's collections change (created, dropped, renamed, or a validator set with `collMod`), until
 * `signal` aborts. The file is only rewritten when its text changes. A failed run is reported and the
 * watch goes on.
 */
export async function watchTypes(
  options: GenTypesOptions,
  out: Output,
  signal: AbortSignal,
): Promise<number> {
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
  } catch (error: unknown) {
    out.error(`error  ${messageOf(error)}`)
    await client.close()
    return 1
  }
  let queue: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (reason: string): void => {
    queue = queue.then(async () => {
      if (signal.aborted) return
      try {
        const { text, count } = await generate(options, client)
        if (await writeIfChanged(options.out, text))
          out.log(`types  wrote ${options.out} (${count} collections, ${reason})`)
      } catch (error: unknown) {
        out.error(`types  not regenerated: ${messageOf(error)}`)
      }
    })
  }
  const soon = (reason: string): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => run(reason), 200)
  }
  run("start")
  const watcher =
    options.dir === undefined
      ? undefined
      : watch(options.dir, { recursive: true }, () => soon("policies changed"))
  const stream = client
    .db(options.database)
    .watch([{ $match: { operationType: { $in: [...SCHEMA_EVENTS] } } }], {
      showExpandedEvents: true,
    })
  stream.on("change", (event) => soon(`${event.operationType} event`))
  stream.on("error", (error: unknown) => out.error(`types  change stream: ${messageOf(error)}`))
  await new Promise<void>((done) => {
    if (signal.aborted) done()
    else signal.addEventListener("abort", () => done(), { once: true })
  })
  if (timer !== undefined) clearTimeout(timer)
  watcher?.close()
  await stream.close().catch(() => undefined)
  await queue
  await client.close()
  return 0
}
