import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { CanopyError, ErrorCode, Long, ObjectId as WireObjectId } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { BSON, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type BatchResult, type Caller, WritePath, type WriteRequest } from "../src/index.ts"

const things = collection("things", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ hidden: { $ne: true } }),
    allow.insert("authenticated"),
    allow.update("authenticated"),
    allow.delete("authenticated"),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const owned = collection("owned", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub"), hidden: { $ne: true } }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const guarded = collection("guarded", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ n: { $lt: 10 } }),
  ],
})

const folded = collection("folded", {
  exposed: true,
  policies: [allow.read("authenticated"), allow.update("authenticated")],
})

const NAMES = ["things", "owned", "guarded", "folded"] as const

const suite = MONGODB_URI === undefined ? describe.skip : describe

function user(sub: string): Caller {
  return {
    context: { roles: new Set(["authenticated"]), claims: { sub }, now: new Date() },
    subject: sub,
  }
}

/** Relaxed EJSON, so exact BSON values compare equal to plain literals. */
function relaxed(value: unknown): unknown {
  return JSON.parse(BSON.EJSON.stringify(value, { relaxed: true }))
}

/** A deterministic generator, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const READ_COMMANDS = new Set(["find", "aggregate", "count", "findAndModify"])
const SEEN = new Set([
  ...READ_COMMANDS,
  "insert",
  "update",
  "delete",
  "commitTransaction",
  "listCollections",
])

suite("read backs of an atomic batch against MongoDB", () => {
  const dbName = `canopy_readbacks_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const oracleName = `${dbName}_oracle`
  let client: MongoClient
  let db: Db
  let oracleDb: Db
  let writes: WritePath
  let oracle: WritePath
  const alice = user("alice")
  const bob = user("bob")

  async function commands<T>(
    body: () => Promise<T>,
    database = dbName,
  ): Promise<{ value: T; names: string[] }> {
    const names: string[] = []
    const listener = (event: { commandName: string; databaseName: string }): void => {
      if (
        SEEN.has(event.commandName) &&
        (event.databaseName === database || event.commandName === "commitTransaction")
      )
        names.push(event.commandName)
    }
    client.on("commandStarted", listener)
    try {
      return { value: await body(), names }
    } finally {
      client.off("commandStarted", listener)
    }
  }

  const batch = (caller: Caller, requests: WriteRequest[]): Promise<BatchResult> =>
    writes.executeBatch(caller, requests)

  const update = (id: unknown, set: Document, name = "things"): WriteRequest => ({
    op: "update",
    collection: name,
    id,
    update: { $set: set },
  })

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    await client.connect()
    db = client.db(dbName)
    oracleDb = client.db(oracleName)
    const engine = testPolicyEngine(createPolicySet([things, owned, guarded, folded]))
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: engine,
    })
    oracle = new WritePath({
      client,
      database: oracleName,
      metaDatabase: `${dbName}_oracle_meta`,
      policies: engine,
    })
    for (const target of [db, oracleDb])
      for (const name of NAMES)
        await target.createCollection(
          name,
          name === "folded" ? { collation: { locale: "en", strength: 2 } } : {},
        )
  })

  afterAll(async () => {
    await db.dropDatabase()
    await oracleDb.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.db(`${dbName}_oracle_meta`).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    for (const target of [db, oracleDb])
      for (const name of NAMES) await target.collection(name).deleteMany({})
  })

  const seedBoth = async (name: string, docs: Document[]): Promise<void> => {
    await db.collection(name).insertMany(docs.map((doc) => ({ ...doc })))
    await oracleDb.collection(name).insertMany(docs.map((doc) => ({ ...doc })))
  }

  describe("command count", () => {
    it("reads the documents of an insert and three updates with one find", async () => {
      await seedBoth("owned", [
        { _id: "a", ownerId: "alice", n: 0 },
        { _id: "b", ownerId: "alice", n: 0 },
        { _id: "c", ownerId: "alice", n: 0 },
      ])
      const run = (): Promise<BatchResult> =>
        batch(alice, [
          { op: "insert", collection: "owned", doc: { _id: "d", ownerId: "alice", n: 0 } },
          update("a", { n: 1 }, "owned"),
          update("b", { n: 2 }, "owned"),
          update("c", { n: 3 }, "owned"),
        ])
      await run()
      await db.collection("owned").deleteOne({ _id: "d" as never })
      const { value, names } = await commands(run)
      expect(names).toEqual([
        "aggregate",
        "insert",
        "update",
        "update",
        "update",
        "find",
        "commitTransaction",
      ])
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: "d", ownerId: "alice", n: 0 }],
        [{ _id: "a", ownerId: "alice", n: 1 }],
        [{ _id: "b", ownerId: "alice", n: 2 }],
        [{ _id: "c", ownerId: "alice", n: 3 }],
      ])
    })

    it("sends one find per collection", async () => {
      await seedBoth("owned", [{ _id: "a", ownerId: "alice" }])
      await seedBoth("things", [{ _id: "a" }, { _id: "b" }])
      await batch(alice, [update("a", { n: 0 }, "owned")])
      const { value, names } = await commands(() =>
        batch(alice, [
          update("a", { n: 1 }, "owned"),
          update("a", { n: 1 }),
          update("b", { n: 1 }),
        ]),
      )
      expect(names.filter((name) => name === "find")).toHaveLength(2)
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: "a", ownerId: "alice", n: 1 }],
        [{ _id: "a", n: 1 }],
        [{ _id: "b", n: 1 }],
      ])
    })

    it("keeps one read per operation when the documents may be the same", async () => {
      await seedBoth("things", [{ _id: 1 }, { _id: 2 }])
      const { names } = await commands(() =>
        batch(alice, [update(1, { n: 1 }), update(2, { n: 2 })]),
      )
      expect(names.filter((name) => name === "find")).toHaveLength(2)
    })

    it("reads a batch of a filter write and a single update at once", async () => {
      await seedBoth("things", [
        { _id: "a", t: 1 },
        { _id: "b", t: 1 },
      ])
      const { value, names } = await commands(() =>
        batch(alice, [
          update("a", { n: 1 }),
          {
            op: "updateMany",
            collection: "things",
            filter: { t: 1 },
            update: { $set: { m: 1 } },
            bulk: true,
          },
        ]),
      )
      expect(names.filter((name) => name === "find")).toHaveLength(2)
      expect(relaxed(value.results[0]?.documents)).toEqual([{ _id: "a", t: 1, n: 1 }])
    })

    it("keeps the single read of a lone update", async () => {
      await seedBoth("things", [{ _id: "a" }])
      const { names } = await commands(() => batch(alice, [update("a", { n: 1 })]))
      expect(names).toEqual(["update", "find", "commitTransaction"])
    })
  })

  describe("what each operation returns", () => {
    it("returns the state after the operation for a document written twice", async () => {
      await seedBoth("things", [{ _id: "a", title: "start" }, { _id: "b" }])
      const { value } = await commands(() =>
        batch(alice, [
          update("a", { title: "one" }),
          update("b", { title: "other" }),
          update("a", { title: "two" }),
        ]),
      )
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: "a", title: "one" }],
        [{ _id: "b", title: "other" }],
        [{ _id: "a", title: "two" }],
      ])
    })

    it("returns the state after the update for a document a later operation deletes", async () => {
      await seedBoth("things", [{ _id: "a", title: "start", secret: "s" }])
      const value = await batch(alice, [
        update("a", { title: "one" }),
        { op: "delete", collection: "things", id: "a" },
      ])
      expect(relaxed(value.results[0]?.documents)).toEqual([{ _id: "a", title: "one" }])
      expect(relaxed(value.results[1]?.documents)).toEqual([{ _id: "a", title: "one" }])
      expect(await db.collection("things").countDocuments()).toBe(0)
    })

    it("returns the state after the update for a document a later bulk operation changes", async () => {
      await seedBoth("things", [{ _id: "a", t: 1 }])
      const value = await batch(alice, [
        update("a", { title: "one" }),
        {
          op: "updateMany",
          collection: "things",
          filter: { t: 1 },
          update: { $set: { title: "bulk" } },
          bulk: true,
        },
      ])
      expect(relaxed(value.results[0]?.documents)).toEqual([{ _id: "a", t: 1, title: "one" }])
    })

    it("treats numeric ids of different BSON types as one document", async () => {
      await seedBoth("things", [{ _id: 1 }])
      const value = await batch(alice, [
        update(1, { title: "int" }),
        update(new Long(1), { title: "long" }),
      ])
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: 1, title: "int" }],
        [{ _id: 1, title: "long" }],
      ])
    })

    it("treats strings that a collation makes equal as one document", async () => {
      await seedBoth("folded", [{ _id: "abc" }, { _id: "other" }])
      const { value, names } = await commands(() =>
        batch(alice, [
          update("ABC", { title: "first" }, "folded"),
          update("other", { title: "x" }, "folded"),
          update("abc", { title: "second" }, "folded"),
        ]),
      )
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: "abc", title: "first" }],
        [{ _id: "other", title: "x" }],
        [{ _id: "abc", title: "second" }],
      ])
      expect(names.filter((name) => name === "find")).toHaveLength(3)
    })

    it("reads ObjectId documents through their own ids", async () => {
      const first = new BSON.ObjectId()
      const second = new BSON.ObjectId()
      await seedBoth("things", [{ _id: first }, { _id: second }])
      const value = await batch(alice, [
        update(new WireObjectId(first.toHexString()), { title: "1" }),
        update(new WireObjectId(second.toHexString()), { title: "2" }),
      ])
      expect(relaxed(value.results.map((result) => result.documents))).toEqual([
        [{ _id: { $oid: first.toHexString() }, title: "1" }],
        [{ _id: { $oid: second.toHexString() }, title: "2" }],
      ])
    })

    it("returns null for a document the caller can no longer read and applies the field rules", async () => {
      await seedBoth("things", [
        { _id: "a", secret: "s" },
        { _id: "b", secret: "s" },
      ])
      const value = await batch(alice, [
        update("a", { hidden: true }),
        update("b", { title: "shown" }),
      ])
      expect(value.results[0]?.documents).toEqual([null])
      expect(relaxed(value.results[1]?.documents)).toEqual([{ _id: "b", title: "shown" }])
    })

    it("never returns documents of another owner, and refuses nothing it refused before", async () => {
      await seedBoth("owned", [
        { _id: "a", ownerId: "alice" },
        { _id: "b", ownerId: "bob" },
        { _id: "c", ownerId: "alice" },
      ])
      const value = await batch(alice, [
        update("a", { n: 1 }, "owned"),
        update("b", { n: 1 }, "owned"),
        update("c", { n: 1 }, "owned"),
      ])
      expect(value.results.map((result) => result.matched)).toEqual([1, 0, 1])
      expect(value.results[1]?.documents).toBeUndefined()
      expect(relaxed(value.results[2]?.documents)).toEqual([{ _id: "c", ownerId: "alice", n: 1 }])
      expect(await db.collection("owned").findOne({ _id: "b" as never })).toEqual({
        _id: "b",
        ownerId: "bob",
      })
    })

    it("still evaluates check in MongoDB for every operation and aborts the batch", async () => {
      await seedBoth("guarded", [
        { _id: "a", ownerId: "alice", n: 1 },
        { _id: "b", ownerId: "alice", n: 1 },
        { _id: "c", ownerId: "alice", n: 1 },
      ])
      let error: unknown
      try {
        await batch(alice, [
          update("a", { n: 2 }, "guarded"),
          update("b", { n: 99 }, "guarded"),
          update("c", { n: 3 }, "guarded"),
        ])
      } catch (caught: unknown) {
        error = caught
      }
      expect(error).toBeInstanceOf(CanopyError)
      expect((error as CanopyError).code).toBe(ErrorCode.PolicyViolation)
      expect((error as CanopyError).details?.["index"]).toBe(1)
      expect((await db.collection("guarded").find({}).toArray()).map((doc) => doc["n"])).toEqual([
        1, 1, 1,
      ])
    })

    it("fails an unreadable read back after a later failing operation without keeping any write", async () => {
      await seedBoth("things", [{ _id: "a" }])
      const error = await batch(alice, [
        update("a", { title: "x" }),
        { op: "insert", collection: "things", doc: { _id: "a" } },
      ]).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(CanopyError)
      expect(await db.collection("things").findOne({ _id: "a" as never })).toEqual({ _id: "a" })
    })

    it("matches a one operation at a time execution over generated batches", async () => {
      const callers = [alice, bob]
      const strings = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]
      const objectIds = ["a", "b", "c"].map((char) => char.repeat(24))
      const pool: unknown[] = [
        ...strings,
        ...strings,
        ...objectIds.map((hex) => new WireObjectId(hex)),
        1,
        2,
        new Long(2),
      ]
      let saved = 0
      let total = 0
      for (let seed = 1; seed <= 120; seed++) {
        const next = random(seed)
        const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
        for (const target of [db, oracleDb])
          for (const name of NAMES) await target.collection(name).deleteMany({})
        const seeded: Document[] = [
          ...strings.map((id, index) => ({
            _id: id,
            ownerId: index % 2 === 0 ? "alice" : "bob",
            n: index,
            secret: "x",
            ...(index % 4 === 3 ? { hidden: true } : {}),
          })),
          ...objectIds.map((hex, index) => ({
            _id: new BSON.ObjectId(hex),
            ownerId: index % 2 === 0 ? "alice" : "bob",
            n: index,
          })),
          { _id: 1, ownerId: "alice", n: 4 },
          { _id: 2, ownerId: "bob", n: 5 },
        ]
        for (const name of ["things", "owned"]) await seedBoth(name, seeded)
        const caller = pick(callers)
        const size = 2 + Math.floor(next() * 5)
        const requests: WriteRequest[] = []
        let fresh = 0
        for (let index = 0; index < size; index++) {
          const name = pick(["things", "owned"])
          const kind = pick([
            "update",
            "update",
            "update",
            "replace",
            "delete",
            "insert",
            ...(next() < 0.15 ? ["updateMany"] : []),
          ])
          const set: Document = pick([
            { n: Math.floor(next() * 5) },
            { hidden: next() < 0.5 },
            { title: `t${index}` },
          ])
          if (kind === "insert") {
            requests.push({
              op: "insert",
              collection: name,
              doc: { _id: `new${seed}_${fresh++}`, ownerId: caller.subject, ...set },
            })
          } else if (kind === "updateMany") {
            requests.push({
              op: "updateMany",
              collection: name,
              filter: { n: { $gte: Math.floor(next() * 5) } },
              update: { $set: set },
              bulk: true,
            })
          } else if (kind === "delete") {
            requests.push({ op: "delete", collection: name, id: pick(pool) })
          } else if (kind === "replace" && name === "things") {
            requests.push({
              op: "replace",
              collection: name,
              id: pick(pool),
              doc: { ownerId: pick(["alice", "bob"]), ...set },
            })
          } else {
            requests.push(update(pick(pool), set, name))
          }
        }
        const expected: unknown[] = []
        let oracleError: unknown
        const sequential = await commands(async () => {
          for (const request of requests) {
            try {
              expected.push((await oracle.executeBatch(caller, [request])).results[0])
            } catch (caught: unknown) {
              oracleError = caught
              break
            }
          }
        }, oracleName)
        const { value, names } = await commands(() =>
          batch(caller, requests).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          ),
        )
        if (oracleError !== undefined) {
          expect(value, `seed ${seed}`).toHaveProperty("error")
          expect(
            ((value as { error: CanopyError }).error as CanopyError).code,
            `seed ${seed}`,
          ).toBe((oracleError as CanopyError).code)
          continue
        }
        expect(value, `seed ${seed}`).toHaveProperty("result")
        const got = (value as { result: BatchResult }).result
        expect(relaxed(got.results), `seed ${seed}`).toEqual(relaxed(expected))
        for (const name of NAMES) {
          const a = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
          const b = await oracleDb.collection(name).find({}).sort({ _id: 1 }).toArray()
          expect(relaxed(a), `seed ${seed} ${name}`).toEqual(relaxed(b))
        }
        total += requests.length
        const finds = (list: string[]): number => list.filter((name) => name === "find").length
        expect(finds(names), `seed ${seed}`).toBeLessThanOrEqual(finds(sequential.names))
        saved += finds(sequential.names) - finds(names)
      }
      expect(total).toBeGreaterThan(300)
      expect(saved).toBeGreaterThan(20)
    })
  })
})
