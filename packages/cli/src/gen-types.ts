import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { PolicyEngine, type PolicySet, type RequestContext, Role } from "@canopy/policy"
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

/**
 * `canopy gen types`: writes the `Database` interface from the collection schemas (validator, then
 * config, then inference). With `check`, exits 1 when the committed file is stale.
 */
export async function genTypes(options: GenTypesOptions, out: Output): Promise<number> {
  let set: PolicySet | undefined
  if (options.dir !== undefined) {
    try {
      set = await directoryPolicies(options.dir).load()
    } catch (error: unknown) {
      out.error(
        `error  policies do not load: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  }
  const client = new MongoClient(options.mongodbUri, { serverSelectionTimeoutMS: 10_000 })
  try {
    await client.connect()
    const db = client.db(options.database)
    const exposed = [...(set?.collections.values() ?? [])].filter((def) => def.exposed)
    const names =
      exposed.length > 0
        ? exposed.map((def) => def.collection)
        : (await db.listCollections({}, { nameOnly: true }).toArray())
            .map((info) => info.name)
            .filter((name) => !name.startsWith("system."))
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
          : {
              ...schema,
              shape: restrictShape(schema.shape, engine.readable(name, ctx), "optional"),
            },
      )
    }
    const text = generateTypes(schemas, {
      ...(options.role === undefined
        ? {}
        : { note: `Fields the ${options.role} role cannot read are optional.` }),
    })
    if (options.check === true) {
      let current: string | undefined
      try {
        current = await readFile(options.out, "utf8")
      } catch {
        current = undefined
      }
      if (current?.replaceAll("\r\n", "\n") === text) {
        out.log(`${options.out} is up to date (${schemas.length} collections)`)
        return 0
      }
      out.error(`${options.out} is out of date; run canopy gen types`)
      return 1
    }
    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, text)
    out.log(`wrote ${options.out} (${schemas.length} collections)`)
    return 0
  } catch (error: unknown) {
    out.error(`error  ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await client.close()
  }
}
