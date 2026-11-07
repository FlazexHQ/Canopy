import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { META_MIGRATIONS, type MetaMigration, migrateMeta, migrationStatus } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("meta migrations", () => {
  const name = `canopy_migrations_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(name)
  })

  afterAll(async () => {
    await meta.dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    await meta.dropDatabase()
  })

  it("creates every meta collection with its indexes, once", async () => {
    const first = await migrateMeta(meta)
    expect(first.applied).toEqual(["create-meta-collections"])
    expect(first.version).toBe(1)
    const names = (await meta.listCollections().toArray()).map((c) => c.name).sort()
    for (const collection of [
      "admin_sessions",
      "admin_users",
      "api_keys",
      "audit_log",
      "migrations",
      "mutations",
      "policies",
      "policy_history",
      "revocations",
      "settings",
    ])
      expect(names).toContain(collection)

    const sessions = await meta.collection("admin_sessions").indexes()
    expect(sessions.find((index) => index.name === "ttl_expires")?.expireAfterSeconds).toBe(0)
    const revocations = await meta.collection("revocations").indexes()
    expect(revocations.find((index) => index.name === "ttl_expires")?.expireAfterSeconds).toBe(0)
    await meta.collection("admin_users").insertOne({ email: "a@example.com" })
    await expect(
      meta.collection("admin_users").insertOne({ email: "a@example.com" }),
    ).rejects.toMatchObject({ code: 11000 })
    await meta.collection("api_keys").insertMany([{ key: "pk1" }, { hash: "h1" }, { hash: "h2" }])
    await expect(meta.collection("api_keys").insertOne({ hash: "h1" })).rejects.toMatchObject({
      code: 11000,
    })

    const second = await migrateMeta(meta)
    expect(second.applied).toEqual([])
    const status = await migrationStatus(meta)
    expect(status.map((s) => [s.version, s.appliedAt instanceof Date])).toEqual([[1, true]])
    expect(await meta.collection("migrations").countDocuments({ _id: "lock" as never })).toBe(0)
  })

  it("keeps a mutations TTL the write path already set", async () => {
    await meta
      .collection("mutations")
      .createIndex({ at: 1 }, { name: "ttl_at", expireAfterSeconds: 3600 })
    await migrateMeta(meta)
    const index = (await meta.collection("mutations").indexes()).find((i) => i.name === "ttl_at")
    expect(index?.expireAfterSeconds).toBe(3600)
  })

  it("lets exactly one of several concurrent nodes run each migration", async () => {
    let runs = 0
    const migrations: MetaMigration[] = [
      ...META_MIGRATIONS,
      {
        version: 2,
        name: "slow",
        async up() {
          runs += 1
          await new Promise((resolve) => setTimeout(resolve, 300))
        },
      },
    ]
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => migrateMeta(meta, { migrations, waitMs: 10_000 })),
    )
    expect(runs).toBe(1)
    expect(results.flatMap((result) => result.applied).sort()).toEqual([
      "create-meta-collections",
      "slow",
    ])
  })

  it("takes over an expired lease but waits for a live one", async () => {
    await meta
      .collection("migrations")
      .insertOne({ _id: "lock" as never, owner: "dead", expiresAt: new Date(Date.now() - 1000) })
    expect((await migrateMeta(meta)).applied).toEqual(["create-meta-collections"])

    await meta.dropDatabase()
    await meta
      .collection("migrations")
      .insertOne({ _id: "lock" as never, owner: "alive", expiresAt: new Date(Date.now() + 60_000) })
    await expect(migrateMeta(meta, { waitMs: 400 })).rejects.toMatchObject({
      code: "CANOPY_UNAVAILABLE",
    })
    expect((await migrationStatus(meta))[0]?.appliedAt).toBeUndefined()
  })

  it("does not record a migration that failed, and releases the lock", async () => {
    const migrations: MetaMigration[] = [
      {
        version: 1,
        name: "broken",
        async up() {
          throw new Error("boom")
        },
      },
    ]
    await expect(migrateMeta(meta, { migrations })).rejects.toThrow("boom")
    expect((await migrationStatus(meta, migrations))[0]?.appliedAt).toBeUndefined()
    expect(await meta.collection("migrations").countDocuments({ _id: "lock" as never })).toBe(0)
  })

  it("refuses migrations out of order", async () => {
    const up = async () => {}
    await expect(
      migrateMeta(meta, {
        migrations: [
          { version: 2, name: "b", up },
          { version: 1, name: "a", up },
        ],
      }),
    ).rejects.toThrow(TypeError)
  })
})
