import { randomBytes } from "node:crypto"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import type { Logger } from "@canopy/realtime"
import { type Db, type IndexDescription, MongoServerError } from "mongodb"

/** One forward only, idempotent change to the meta database. */
export interface MetaMigration {
  /** Applied in increasing order; never reused. */
  readonly version: number
  readonly name: string
  up(meta: Db): Promise<void>
}

/** Options of {@link migrateMeta}. */
export interface MigrateOptions {
  readonly logger?: Logger
  /** How long the lease of the migrating node lasts before another node may take over. @default 60000 */
  readonly leaseMs?: number
  /** How long a node waits for another node's migration. @default 120000 */
  readonly waitMs?: number
  /** The migrations to run. Defaults to {@link META_MIGRATIONS}; tests pass their own. */
  readonly migrations?: readonly MetaMigration[]
  readonly signal?: AbortSignal
}

/** The outcome of {@link migrateMeta}. */
export interface MigrateResult {
  /** The migrations this call applied, in order. */
  readonly applied: readonly string[]
  /** The highest applied version. */
  readonly version: number
}

/** The state of one known migration. */
export interface MigrationStatus {
  readonly version: number
  readonly name: string
  readonly appliedAt: Date | undefined
}

const LOCK_ID = "lock"
const NAMESPACE_EXISTS = 48
const INDEX_CONFLICTS = new Set([85, 86])

interface MigrationDocument {
  _id: number | string
  name?: string
  appliedAt?: Date
  owner?: string
  expiresAt?: Date
}

async function createCollection(meta: Db, name: string): Promise<void> {
  try {
    await meta.createCollection(name)
  } catch (error: unknown) {
    if (!(error instanceof MongoServerError) || error.code !== NAMESPACE_EXISTS) throw error
  }
}

async function createIndexes(
  meta: Db,
  name: string,
  indexes: readonly IndexDescription[],
): Promise<void> {
  for (const index of indexes) {
    try {
      await meta.collection(name).createIndexes([index])
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || !INDEX_CONFLICTS.has(Number(error.code)))
        throw error
    }
  }
}

/**
 * The meta database migrations. Indexes that already exist with other options (for example the TTL of
 * `mutations`, which the write path sets from the config) are kept as they are.
 */
export const META_MIGRATIONS: readonly MetaMigration[] = [
  {
    version: 1,
    name: "create-meta-collections",
    async up(meta) {
      const collections: Readonly<Record<string, readonly IndexDescription[]>> = {
        policies: [],
        policy_history: [
          { key: { collection: 1, version: -1 }, name: "collection_version", unique: true },
        ],
        audit_log: [
          { key: { at: -1 }, name: "at" },
          { key: { action: 1, at: -1 }, name: "action_at" },
          { key: { "actor.id": 1, at: -1 }, name: "actor_at" },
        ],
        api_keys: [
          {
            key: { hash: 1 },
            name: "hash",
            unique: true,
            partialFilterExpression: { hash: { $type: "string" } },
          },
          {
            key: { key: 1 },
            name: "key",
            unique: true,
            partialFilterExpression: { key: { $type: "string" } },
          },
        ],
        admin_users: [{ key: { email: 1 }, name: "email", unique: true }],
        admin_sessions: [
          { key: { expiresAt: 1 }, name: "ttl_expires", expireAfterSeconds: 0 },
          { key: { userId: 1 }, name: "user" },
        ],
        revocations: [{ key: { expiresAt: 1 }, name: "ttl_expires", expireAfterSeconds: 0 }],
        mutations: [{ key: { at: 1 }, name: "ttl_at", expireAfterSeconds: 86_400 }],
        settings: [],
      }
      for (const [name, indexes] of Object.entries(collections)) {
        await createCollection(meta, name)
        await createIndexes(meta, name, indexes)
      }
    },
  },
]

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function check(migrations: readonly MetaMigration[]): void {
  let previous = 0
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous)
      throw new TypeError("Meta migrations must have increasing integer versions")
    previous = migration.version
  }
}

/** Lists the known migrations and when each was applied. */
export async function migrationStatus(
  meta: Db,
  migrations: readonly MetaMigration[] = META_MIGRATIONS,
): Promise<MigrationStatus[]> {
  const applied = new Map<number, Date | undefined>()
  const docs = await meta
    .collection<MigrationDocument>("migrations")
    .find({ _id: { $type: "number" as "double" } })
    .toArray()
  for (const doc of docs) if (typeof doc._id === "number") applied.set(doc._id, doc.appliedAt)
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    appliedAt: applied.get(migration.version),
  }))
}

/**
 * Brings the meta database up to date. Migrations are tracked in `canopy.migrations` and run under a lease
 * lock, so when several nodes start together exactly one migrates and the others wait for it. Each
 * migration is idempotent, so one interrupted by a crash is simply run again.
 */
export async function migrateMeta(meta: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = options.migrations ?? META_MIGRATIONS
  check(migrations)
  const leaseMs = options.leaseMs ?? 60_000
  const deadline = Date.now() + (options.waitMs ?? 120_000)
  const coll = meta.collection<MigrationDocument>("migrations")
  const owner = randomBytes(12).toString("hex")
  const pending = async (): Promise<MetaMigration[]> => {
    const status = await migrationStatus(meta, migrations)
    const done = new Set(status.filter((s) => s.appliedAt !== undefined).map((s) => s.version))
    return migrations.filter((migration) => !done.has(migration.version))
  }
  const latest = (): number => migrations.at(-1)?.version ?? 0

  if ((await pending()).length === 0) return { applied: [], version: latest() }
  for (;;) {
    const now = new Date()
    let acquired = false
    try {
      const lock = await coll.findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ expiresAt: { $lt: now } }, { owner }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) } },
        { upsert: true, returnDocument: "after" },
      )
      acquired = lock?.owner === owner
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error
    }
    if (acquired) break
    if (Date.now() > deadline)
      throw new CanopyError(
        ErrorCode.Unavailable,
        "Another node holds the meta migration lock; retry once it finishes",
      )
    await sleep(250, options.signal)
    if ((await pending()).length === 0) return { applied: [], version: latest() }
  }

  const applied: string[] = []
  try {
    for (const migration of await pending()) {
      options.logger?.info(
        { version: migration.version, name: migration.name },
        "applying meta migration",
      )
      await migration.up(meta)
      await coll.updateOne(
        { _id: migration.version },
        { $set: { name: migration.name, appliedAt: new Date() } },
        { upsert: true },
      )
      await coll.updateOne(
        { _id: LOCK_ID, owner },
        { $set: { expiresAt: new Date(Date.now() + leaseMs) } },
      )
      applied.push(migration.name)
    }
  } finally {
    await coll.deleteOne({ _id: LOCK_ID, owner })
  }
  return { applied, version: latest() }
}
