import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  type Actor,
  AuditLog,
  type Canopy,
  createCanopy,
  defineConfig,
  definitionFromInput,
  PolicyStore,
} from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

const alice: Actor = { type: "admin", id: "u_alice", email: "alice@example.com", role: "owner" }

const readAll = {
  exposed: true,
  realtime: true,
  policies: [{ name: "read all", kind: "permissive", ops: ["read"], roles: ["anon"] }],
}
const readPublished = {
  exposed: true,
  realtime: true,
  policies: [
    {
      name: "read published",
      kind: "permissive",
      ops: ["read"],
      roles: ["anon"],
      using: { published: true },
    },
  ],
}

suite("policy lifecycle", () => {
  const dbName = `canopy_policies_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let meta: Db
  let audit: AuditLog
  let store: PolicyStore

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(metaName)
    audit = new AuditLog(meta)
    store = new PolicyStore({ client: mongo, metaDatabase: metaName, audit, writable: true })
  })

  afterAll(async () => {
    await meta.dropDatabase()
    await mongo.db(dbName).dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    for (const name of ["policies", "policy_history", "audit_log"])
      await meta.collection(name).deleteMany({})
  })

  const publish = (input: unknown, expectedVersion: number, comment?: string) =>
    store.publish({
      definition: definitionFromInput("posts", input),
      expectedVersion,
      actor: alice,
      ...(comment === undefined ? {} : { comment }),
    })

  it("publishes versions, keeps every one in the history and audits each", async () => {
    const first = await publish(readAll, 0, "first")
    expect(first.stored.version).toBe(1)
    expect(first.stored.updatedBy).toBe("admin:alice@example.com")
    const second = await publish(readPublished, 1)
    expect(second.stored.version).toBe(2)
    expect(second.stored.policies[0]?.using).toBe('{"published":true}')

    const stored = await meta.collection("policies").findOne({ _id: "posts" as never })
    expect(stored?.["version"]).toBe(2)
    expect(stored?.["hash"]).toBe(second.stored.hash)
    const history = await store.versions("posts")
    expect(history.map((entry) => [entry.version, entry.comment])).toEqual([
      [2, undefined],
      [1, "first"],
    ])
    const entries = await audit.list({ action: "policy.publish" })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      actor: { id: "u_alice" },
      target: { collection: "posts", version: 2 },
      outcome: "ok",
    })
    expect(entries[0]?.diff?.before).toMatchObject({ version: 1 })
    expect((entries[1]?.diff?.before as unknown) ?? null).toBeNull()
  })

  it("refuses a publish made against another version with 409 and changes nothing", async () => {
    await publish(readAll, 0)
    await expect(publish(readPublished, 0)).rejects.toMatchObject({
      code: "CANOPY_CONFLICT",
      status: 409,
      details: { currentVersion: 1, expectedVersion: 0 },
    })
    await expect(publish(readPublished, 5)).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
    expect((await store.get("posts"))?.version).toBe(1)
    expect(await meta.collection("policy_history").countDocuments()).toBe(1)
    expect(await meta.collection("audit_log").countDocuments()).toBe(1)
  })

  it("lets exactly one of several concurrent publishes of the same version win", async () => {
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(() => publish(readPublished, 0)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const result of results.filter((r) => r.status === "rejected"))
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "CANOPY_CONFLICT" })
    expect((await store.get("posts"))?.version).toBe(1)
    expect(await meta.collection("audit_log").countDocuments()).toBe(1)
  })

  it("validates and lints before storing anything", async () => {
    await expect(
      publish(
        { ...readAll, policies: [{ name: "x", kind: "permissive", ops: ["read"], roles: [] }] },
        0,
      ),
    ).rejects.toMatchObject({ code: "CANOPY_VALIDATION_FAILED" })
    await expect(
      publish(
        {
          ...readAll,
          policies: [
            {
              name: "bad",
              kind: "permissive",
              ops: ["read"],
              roles: ["anon"],
              using: { $where: "1" },
            },
          ],
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "CANOPY_VALIDATION_FAILED" })
    expect(() =>
      definitionFromInput("posts", {
        ...readAll,
        policies: [{ ...readAll.policies[0], kind: "superuser" }],
      }),
    ).toThrow(/kind must be one of/)
    expect(() => definitionFromInput("posts", { ...readAll, extra: true })).toThrow(/not allowed/)
    const lintError = publish(
      {
        exposed: true,
        realtime: false,
        policies: [{ name: "anyone writes", kind: "permissive", ops: ["insert"], roles: ["anon"] }],
      },
      0,
    )
    await expect(lintError).rejects.toMatchObject({
      code: "CANOPY_VALIDATION_FAILED",
      details: { findings: [{ rule: "public-allow-all" }] },
    })
    expect(await meta.collection("policies").countDocuments()).toBe(0)
    expect(await meta.collection("audit_log").countDocuments()).toBe(0)
  })

  it("rolls back by republishing an earlier version as a new one", async () => {
    await publish(readAll, 0)
    await publish(readPublished, 1)
    const rolled = await store.rollback({
      collection: "posts",
      version: 1,
      expectedVersion: 2,
      actor: alice,
      comment: "too strict",
    })
    expect(rolled.stored.version).toBe(3)
    expect(rolled.stored.hash).toBe((await store.versions("posts"))[2]?.hash)
    expect(rolled.stored.policies[0]?.name).toBe("read all")
    const [latest] = await store.versions("posts", { limit: 1 })
    expect(latest).toMatchObject({ version: 3, rollbackOf: 1, comment: "too strict" })
    const [entry] = await audit.list({ action: "policy.rollback" })
    expect(entry).toMatchObject({ target: { version: 3 }, details: { rollbackOf: 1 } })
    await expect(
      store.rollback({ collection: "posts", version: 9, expectedVersion: 3, actor: alice }),
    ).rejects.toMatchObject({ code: "CANOPY_NOT_FOUND" })
    await expect(
      store.rollback({ collection: "posts", version: 1, expectedVersion: 2, actor: alice }),
    ).rejects.toMatchObject({ code: "CANOPY_CONFLICT" })
  })

  it("records a version that was stored before history existed when it is replaced", async () => {
    await meta.collection("policies").insertOne({
      _id: "posts" as never,
      version: 4,
      exposed: true,
      realtime: false,
      policies: [{ name: "legacy", kind: "permissive", ops: ["read"], roles: ["anon"] }],
      hash: "sha256:legacy",
      updatedBy: "cli",
    })
    await publish(readAll, 4)
    expect(
      (await store.versions("posts")).map((entry) => [entry.version, entry.publishedBy]),
    ).toEqual([
      [5, "admin:alice@example.com"],
      [4, "cli"],
    ])
  })

  it("refuses to publish when policies come from a directory", async () => {
    const readOnly = new PolicyStore({
      client: mongo,
      metaDatabase: metaName,
      audit,
      writable: false,
    })
    await expect(
      readOnly.publish({
        definition: definitionFromInput("posts", readAll),
        expectedVersion: 0,
        actor: alice,
      }),
    ).rejects.toMatchObject({ code: "CANOPY_FORBIDDEN" })
  })

  describe("hot reload", () => {
    let canopy: Canopy
    let server: Server
    let base: string

    beforeAll(async () => {
      canopy = await createCanopy(
        defineConfig({
          mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
          keys: { publishable: ["pk_hot"] },
          realtime: { checkpoints: "off" },
          policies: { source: "database" },
        }),
        { env: {} },
      )
      server = createServer(canopy.node())
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      await mongo
        .db(dbName)
        .collection("posts")
        .insertMany([
          { _id: "a" as never, published: true },
          { _id: "b" as never, published: false },
        ])
    })

    afterAll(async () => {
      await canopy.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const visible = async (): Promise<string[] | number> => {
      const response = await fetch(`${base}/rest/v1/posts`, { headers: { apikey: "pk_hot" } })
      if (response.status !== 200) return response.status
      return ((await response.json()) as { data: { _id: string }[] }).data.map((d) => d._id).sort()
    }

    const eventually = async (expected: unknown): Promise<void> => {
      const started = Date.now()
      for (;;) {
        const value = await visible()
        if (JSON.stringify(value) === JSON.stringify(expected)) return
        if (Date.now() - started > 3000)
          throw new Error(`still ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    it("serves each published version, and the rollback, without a restart", async () => {
      await eventually(404)
      await publish(readAll, 0)
      await eventually(["a", "b"])
      await publish(readPublished, 1)
      await eventually(["a"])
      await store.rollback({ collection: "posts", version: 1, expectedVersion: 2, actor: alice })
      await eventually(["a", "b"])
      expect(canopy.policies.collection("posts")?.policies[0]?.name).toBe("read all")
    })
  })
})
