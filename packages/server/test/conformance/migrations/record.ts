import { deepStrictEqual, rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { BSON, type Db, type Document } from "mongodb"
import { META_MIGRATIONS, migrateMeta } from "../../../src/migrations.ts"
import { type VectorOptions, vectorFile } from "../vector-file.ts"

const appliedAt = new Date("2026-11-25T00:00:00.000Z")
const future = new Date("2099-01-01T00:00:00.000Z")
const epoch = new Date(0)
const fixtures: readonly Readonly<Record<string, Document>>[] = [
  {
    settings: { _id: "settings", requestLogRetentionDays: 30 },
    policies: { _id: "orders", version: 1 },
    policy_history: { _id: "orders:1", collection: "orders", version: 1 },
    api_keys: { _id: "key", hash: "example" },
    admin_users: { _id: "owner", email: "owner@example.test" },
    admin_sessions: { _id: "session", userId: "owner", expiresAt: future },
    audit_log: { _id: "audit", at: appliedAt, action: "settings.update", actor: { id: "owner" } },
    revocations: { _id: "revoked", expiresAt: future },
    mutations: { _id: "mutation", at: future },
  },
  { request_log: { _id: "request", at: future, status: 200 } },
  { admin_tokens: { _id: "token", hash: "example", userId: "owner", createdAt: appliedAt } },
  {
    webhook_deliveries: { _id: "delivery", status: "pending", hook: "nightly", nextAt: appliedAt },
    webhook_dead_letters: { _id: "letter", hook: "nightly", failedAt: appliedAt },
    webhook_schedules: { _id: "nightly", lastAt: appliedAt },
  },
  {
    storage_objects: {
      _id: "object",
      bucket: "images",
      path: "sample.png",
      owner: "owner",
      key: "sample",
    },
    storage_uploads: { _id: "upload", expiresAt: future },
  },
  { storage_variants: { _id: "variant", key: "sample:thumbnail" } },
]

async function snapshot(meta: Db) {
  const names = (await meta.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .sort()
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const collection = meta.collection<Document & { _id: unknown }>(name)
        const documents = await collection
          .find({}, { promoteValues: false })
          .sort({ _id: 1 })
          .toArray()
        if (name === "migrations") {
          for (const document of documents) {
            if (document["appliedAt"] instanceof Date) document["appliedAt"] = appliedAt
            if (document["_id"] === "lock" && typeof document["owner"] === "string") {
              document["owner"] = "interrupted"
              if (document["expiresAt"] instanceof Date && document["expiresAt"] > epoch)
                document["expiresAt"] = future
            }
          }
        }
        const indexes = (await collection.indexes({ promoteValues: false })).sort((a, b) =>
          (a.name ?? "").localeCompare(b.name ?? "", "en"),
        )
        return [name, BSON.EJSON.serialize({ documents, indexes }, { relaxed: false })]
      }),
    ),
  )
}

async function seed(meta: Db, version: number) {
  for (const migration of META_MIGRATIONS.slice(0, version)) {
    await migration.up(meta)
    await meta.collection<{ _id: number; name: string; appliedAt: Date }>("migrations").insertOne({
      _id: migration.version,
      name: migration.name,
      appliedAt,
    })
    for (const [name, document] of Object.entries(fixtures[migration.version - 1] ?? {})) {
      await meta.collection<Document>(name).insertOne(document)
    }
  }
}

/** Captures every upgrade path and recovery from a partially applied migration. */
export async function recordMigrations(options: VectorOptions): Promise<string[]> {
  const meta = options.client.db(`canopy_oracle_migrations_${randomUUID()}`)
  const cases = []
  try {
    for (let start = 0; start <= META_MIGRATIONS.length; start += 1) {
      await seed(meta, start)
      const before = await snapshot(meta)
      const steps = []
      for (let target = start + 1; target <= META_MIGRATIONS.length; target += 1) {
        const result = await migrateMeta(meta, { migrations: META_MIGRATIONS.slice(0, target) })
        deepStrictEqual(result.applied, [META_MIGRATIONS[target - 1]?.name])
        steps.push({ result, state: await snapshot(meta) })
      }
      const replay = await migrateMeta(meta)
      deepStrictEqual(replay.applied, [])
      const final = await snapshot(meta)
      await meta.dropDatabase()
      await seed(meta, start)
      const direct = await migrateMeta(meta)
      deepStrictEqual(
        direct.applied,
        META_MIGRATIONS.slice(start).map(({ name }) => name),
      )
      deepStrictEqual(await snapshot(meta), final)
      cases.push({ start, before, steps, direct, replay })
      await meta.dropDatabase()
    }
    await seed(meta, 3)
    const leases = meta.collection<{ _id: string; owner: string; expiresAt: Date }>("migrations")
    const migration = META_MIGRATIONS.find(({ version }) => version === 4)
    if (migration === undefined) throw new Error("The webhooks migration is missing")
    const partial = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const interruption = new Error("Interrupted after creating the first webhook index")
    const firstNode = migrateMeta(meta, {
      migrations: META_MIGRATIONS.map((item) =>
        item === migration
          ? {
              ...item,
              async up(db) {
                await db.createCollection("webhook_deliveries")
                await db
                  .collection("webhook_deliveries")
                  .createIndex({ status: 1, nextAt: 1 }, { name: "status_next" })
                partial.resolve()
                await resume.promise
                throw interruption
              },
            }
          : item,
      ),
    }).then(
      () => {
        throw new Error("The interrupted migration finished")
      },
      (error: unknown) => {
        partial.reject(error)
        return error
      },
    )
    let recovery: unknown
    try {
      await partial.promise
      const interrupted = await snapshot(meta)
      const blocked = "CANOPY_UNAVAILABLE"
      await rejects(migrateMeta(meta, { waitMs: 1 }), { code: blocked })
      deepStrictEqual(await snapshot(meta), interrupted)
      deepStrictEqual(
        (await leases.updateOne({ _id: "lock" }, { $set: { expiresAt: epoch } })).modifiedCount,
        1,
      )
      const expired = await snapshot(meta)
      const resumed = await migrateMeta(meta)
      deepStrictEqual(
        resumed.applied,
        META_MIGRATIONS.slice(3).map(({ name }) => name),
      )
      recovery = { interrupted, blocked, expired, resumed, state: await snapshot(meta) }
    } finally {
      resume.resolve()
      deepStrictEqual(await firstNode, interruption)
    }
    deepStrictEqual(await leases.findOne({ _id: "lock" }), null)
    return await vectorFile(options, "upgrades.json", {
      cases,
      recovery,
    })
  } finally {
    await meta.dropDatabase()
  }
}
