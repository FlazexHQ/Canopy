import {
  type CollectionSchema,
  fromJsonSchema,
  type InferOptions,
  inferSchema,
  type ObjectShape,
  type Shape,
} from "@canopy/schema"
import type { Db, Document } from "mongodb"
import { fromDriverError } from "./errors.ts"

/** Options for reading collection schemas from MongoDB. */
export interface SchemaSourceOptions {
  /** JSON Schemas from `canopy.config.ts`, by collection. They apply when a collection has no validator. */
  readonly overrides?: Readonly<Record<string, unknown>>
  /** How many documents inference reads. Defaults to 1,000. */
  readonly sampleSize?: number
  readonly infer?: InferOptions
  readonly maxTimeMS?: number
}

const EXACT_BSON = { promoteValues: false, bsonRegExp: true } as const
const EMPTY: ObjectShape = { kind: "object", fields: {}, open: true }

function asObject(shape: Shape): ObjectShape | undefined {
  if (shape.kind === "object") return shape
  if (shape.kind === "union")
    return shape.of.find((member) => member.kind === "object") as ObjectShape | undefined
  return undefined
}

/**
 * Reads the schema of one collection, from the first source that has one: the collection's `$jsonSchema`
 * validator, then the configured override, then inference from the newest documents by `_id` (a
 * deterministic sample, so generated types only change when the data does).
 */
export async function loadSchema(
  db: Db,
  name: string,
  options: SchemaSourceOptions = {},
): Promise<CollectionSchema> {
  try {
    const [info] = await db.listCollections({ name }, { nameOnly: false }).toArray()
    const validator = (info as { options?: { validator?: Document } } | undefined)?.options
      ?.validator
    const jsonSchema = validator?.["$jsonSchema"]
    if (jsonSchema !== undefined)
      return { name, shape: asObject(fromJsonSchema(jsonSchema)) ?? EMPTY, source: "validator" }
    const override = options.overrides?.[name]
    if (override !== undefined)
      return { name, shape: asObject(fromJsonSchema(override)) ?? EMPTY, source: "config" }
    const docs = await db
      .collection(name)
      .find(
        {},
        {
          sort: { _id: -1 },
          limit: options.sampleSize ?? 1000,
          maxTimeMS: options.maxTimeMS ?? 10_000,
          ...EXACT_BSON,
        },
      )
      .toArray()
    return inferSchema(name, docs as Record<string, unknown>[], options.infer ?? {})
  } catch (error: unknown) {
    throw fromDriverError(error, true)
  }
}

/** Options for {@link SchemaCache}. */
export interface SchemaCacheOptions extends SchemaSourceOptions {
  /** How long a schema is reused. Defaults to 60 seconds. */
  readonly ttlMs?: number
  readonly now?: () => number
}

/**
 * Caches collection schemas. Entries expire after `ttlMs`; call {@link SchemaCache.invalidate} when a
 * collection's validator changes or its documents change shape.
 */
export class SchemaCache {
  private readonly db: Db
  private readonly options: SchemaCacheOptions
  private readonly entries = new Map<string, { at: number; schema: Promise<CollectionSchema> }>()
  private generation = 0

  constructor(db: Db, options: SchemaCacheOptions = {}) {
    this.db = db
    this.options = options
  }

  /** Changes whenever a cached schema is loaded again or invalidated. */
  get version(): number {
    return this.generation
  }

  /** Returns the schema of a collection, loading it when it is missing or stale. */
  get(name: string): Promise<CollectionSchema> {
    const now = (this.options.now ?? Date.now)()
    const entry = this.entries.get(name)
    if (entry !== undefined && now - entry.at < (this.options.ttlMs ?? 60_000)) return entry.schema
    this.generation += 1
    const schema = loadSchema(this.db, name, this.options)
    void schema.catch(() => {
      if (this.entries.get(name)?.schema === schema) this.entries.delete(name)
    })
    this.entries.set(name, { at: now, schema })
    return schema
  }

  /** Returns the schemas of several collections. */
  async all(names: Iterable<string>): Promise<Map<string, CollectionSchema>> {
    const list = [...new Set(names)].sort()
    const schemas = await Promise.all(list.map((name) => this.get(name)))
    return new Map(list.map((name, index) => [name, schemas[index] as CollectionSchema]))
  }

  /** Drops one cached schema, or all of them. */
  invalidate(name?: string): void {
    if (name === undefined) this.entries.clear()
    else this.entries.delete(name)
    this.generation += 1
  }
}
