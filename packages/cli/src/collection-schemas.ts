import { PolicyEngine, type RequestContext, Role } from "@canopy/policy"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { directoryPolicies } from "@canopy/realtime"
import { loadSchema } from "@canopy/rest"
import { type CollectionSchema, restrictShape } from "@canopy/schema"
import type { MongoClient } from "mongodb"

/** Where `canopy pull` and `canopy schema diff` read the database's collection schemas from. */
export interface LoadSchemasOptions {
  readonly database: string
  /** The policy directory. Its exposed collections are read; without one, every collection is. */
  readonly dir?: string
  /** Apply this role's field visibility: fields it cannot read become optional. */
  readonly role?: string
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
  options: LoadSchemasOptions,
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
