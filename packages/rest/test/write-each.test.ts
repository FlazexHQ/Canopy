import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { CanopyError, ErrorCode, Long, toCt, ObjectId as WireObjectId } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import {
  BSON,
  type ChangeStreamDocument,
  type Db,
  type Document,
  MongoClient,
  MongoClientBulkWriteError,
  MongoNetworkError,
  MongoServerError,
} from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type BatchItem,
  type BatchItemResult,
  type Caller,
  WritePath,
  type WriteRequest,
} from "../src/index.ts"

const owned = collection("owned", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub"), hidden: { $ne: true } }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

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
  policies: [
    allow.read("authenticated"),
    allow.insert("authenticated"),
    allow.update("authenticated"),
  ],
})

const keyed = collection("keyed", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const checked = collection("checked", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const NAMES = ["owned", "things", "guarded", "folded", "keyed", "checked"] as const

const suite = MONGODB_URI === undefined ? describe.skip : describe

function user(sub: string): Caller {
  return {
    context: { roles: new Set(["authenticated"]), claims: { sub }, now: new Date() },
    subject: sub,
  }
}

const service: Caller = {
  context: { roles: new Set(["service"]), claims: null, now: new Date() },
  subject: "service",
}

/** Canonical EJSON: exact BSON types and field order, so any difference between two documents shows. */
function exact(value: unknown): string {
  return BSON.EJSON.stringify(value, { relaxed: false })
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

const COMMANDS = new Set([
  "insert",
  "update",
  "delete",
  "find",
  "findAndModify",
  "aggregate",
  "bulkWrite",
  "commitTransaction",
  "abortTransaction",
])

/** What an operation did, as a string, without its cluster time: its result or its error. */
function describeItem(item: BatchItemResult): string {
  if ("error" in item) {
    const { error } = item
    return exact({ error: error.code, message: error.message, details: error.details ?? null })
  }
  const { ct: _ct, ...rest } = item.result as unknown as Document
  return exact(rest)
}

suite("non atomic batches against MongoDB", () => {
  const dbName = `canopy_each_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const oracleName = `${dbName}_oracle`
  let client: MongoClient
  let db: Db
  let oracleDb: Db
  let writes: WritePath
  let single: WritePath
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
        COMMANDS.has(event.commandName) &&
        (event.databaseName === database ||
          event.commandName === "bulkWrite" ||
          event.commandName.endsWith("Transaction"))
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

  const items = (...requests: WriteRequest[]): BatchItem[] =>
    requests.map((request) => ({ request }))

  const update = (id: unknown, set: Document, name = "owned"): WriteRequest => ({
    op: "update",
    collection: name,
    id,
    update: { $set: set },
  })

  const insert = (doc: Document, name = "owned"): WriteRequest => ({
    op: "insert",
    collection: name,
    doc,
  })

  const replace = (
    id: unknown,
    doc: Document,
    name = "owned",
    extra: Document = {},
  ): WriteRequest => ({ op: "replace", collection: name, id, doc, ...extra }) as WriteRequest

  const documentsOf = (item: BatchItemResult | undefined): unknown =>
    item !== undefined && "result" in item ? JSON.parse(exact(item.result.documents)) : undefined

  /** The same operations one at a time, as the write path ran a non atomic batch before it grouped. */
  async function oneAtATime(caller: Caller, batch: BatchItem[]): Promise<BatchItemResult[]> {
    const out: BatchItemResult[] = []
    for (const item of batch) {
      try {
        out.push({
          result: await oracle.execute(
            caller,
            item.request,
            item.mutationId === undefined ? {} : { mutationId: item.mutationId },
          ),
        })
      } catch (error: unknown) {
        if (!(error instanceof CanopyError)) throw error
        out.push({ error })
      }
    }
    return out
  }

  /** Whether the server has the client `bulkWrite` command (MongoDB 8.0 and later), which grouping needs. */
  let grouping = false

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    await client.connect()
    const hello = await client.db("admin").command({ hello: 1 })
    grouping = Number(hello["maxWireVersion"]) >= 25
    db = client.db(dbName)
    oracleDb = client.db(oracleName)
    const engine = testPolicyEngine(
      createPolicySet([owned, things, guarded, folded, keyed, checked]),
    )
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: engine,
    })
    single = new WritePath({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: engine,
      groupBatches: false,
    })
    oracle = new WritePath({
      client,
      database: oracleName,
      metaDatabase: `${dbName}_oracle_meta`,
      policies: engine,
    })
    for (const target of [db, oracleDb]) {
      for (const name of NAMES) {
        if (name === "folded")
          await target.createCollection(name, { collation: { locale: "en", strength: 2 } })
        else if (name === "checked")
          await target.createCollection(name, {
            validator: { $jsonSchema: { properties: { label: { bsonType: "string" } } } },
          })
        else await target.createCollection(name)
      }
      await target.collection("keyed").createIndex({ email: 1 }, { unique: true, sparse: true })
    }
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

  const owners = (): Document[] =>
    [1, 2, 3, 4, 5, 6].map((id) => ({ _id: id, ownerId: "alice", n: id, secret: "s" }))

  describe("commands", () => {
    // The batch of the D0 report: an insert, three updates and a replace, with numeric ids.
    const d0 = (): BatchItem[] =>
      items(
        insert({ _id: 100, ownerId: "alice", n: 0 }),
        update(1, { n: 11 }),
        update(2, { n: 12 }),
        update(3, { n: 13 }),
        replace(4, { ownerId: "alice", n: 14 }),
      )

    it("runs a batch one operation at a time on a server without the bulkWrite command", async (ctx) => {
      if (grouping) ctx.skip()
      await seedBoth("owned", owners())
      const sent = await commands(() => writes.executeEach(alice, d0()))
      expect(sent.names).not.toContain("bulkWrite")
      expect(sent.value.every((item) => "result" in item)).toBe(true)
      const alone = await oneAtATime(alice, d0())
      expect(sent.value.map(describeItem)).toEqual(alone.map(describeItem))
    })

    it("sends the batch of an insert, three updates and a replace in four commands", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("owned", owners())
      await writes.executeEach(alice, d0())
      await db.collection("owned").deleteOne({ _id: 100 as never })
      const grouped = await commands(() => writes.executeEach(alice, d0()))
      expect(grouped.names).toEqual(["aggregate", "aggregate", "bulkWrite", "find"])
      expect(grouped.value.every((item) => "result" in item)).toBe(true)
      expect(documentsOf(grouped.value[0])).toEqual([
        { _id: { $numberInt: "100" }, ownerId: "alice", n: { $numberInt: "0" } },
      ])
      expect(documentsOf(grouped.value[2])).toEqual([
        { _id: { $numberInt: "2" }, ownerId: "alice", n: { $numberInt: "12" } },
      ])
      expect(documentsOf(grouped.value[4])).toEqual([
        { _id: { $numberInt: "4" }, ownerId: "alice", n: { $numberInt: "14" } },
      ])
    })

    it("sent one at a time the same batch takes more than twice the commands", async () => {
      await seedBoth("owned", owners())
      await single.executeEach(alice, d0())
      await db.collection("owned").deleteOne({ _id: 100 as never })
      const alone = await commands(() => single.executeEach(alice, d0()))
      expect(alone.names).toEqual([
        "aggregate",
        "insert",
        "update",
        "find",
        "update",
        "find",
        "update",
        "find",
        "aggregate",
        "update",
      ])
    })

    it("checks and writes a hundred inserts in two commands", async (ctx) => {
      if (!grouping) ctx.skip()
      const batch = Array.from({ length: 100 }, (_, index) =>
        insert({ _id: index + 1, ownerId: "alice", n: index }),
      )
      const { value, names } = await commands(() => writes.executeEach(alice, items(...batch)))
      expect(names).toEqual(["aggregate", "bulkWrite"])
      expect(value.every((item) => "result" in item)).toBe(true)
      expect(await db.collection("owned").countDocuments()).toBe(100)
    })

    it("sends operations one at a time when grouping is off", async () => {
      await seedBoth("owned", owners())
      const { value, names } = await commands(() =>
        single.executeEach(alice, items(update(1, { n: 9 }), update(2, { n: 9 }))),
      )
      expect(names).not.toContain("bulkWrite")
      expect(value.every((item) => "result" in item)).toBe(true)
    })

    it("sends an operation with a mutation ID, a delete and a filter write on their own", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth(
        "things",
        [1, 2, 3, 4, 5, 6].map((id) => ({ _id: id })),
      )
      const { value, names } = await commands(() =>
        writes.executeEach(alice, [
          { request: update(1, { n: 1 }, "things") },
          { request: update(2, { n: 1 }, "things"), mutationId: "mutation-0001" },
          { request: update(3, { n: 1 }, "things") },
          { request: { op: "delete", collection: "things", id: 4 } },
          { request: update(5, { n: 1 }, "things") },
          { request: update(6, { n: 1 }, "things") },
        ]),
      )
      expect(value.every((item) => "result" in item)).toBe(true)
      expect(names).toEqual([
        "update",
        "find",
        "bulkWrite",
        "find",
        "commitTransaction",
        "update",
        "find",
        "findAndModify",
        "bulkWrite",
        "find",
      ])
    })
  })

  describe("what each operation reports", () => {
    it("reports matched and modified of each write, and the state after it", async () => {
      await seedBoth("owned", owners())
      const result = await writes.executeEach(
        alice,
        items(
          update(1, { n: 1 }),
          update(2, { n: 22 }),
          update(7, { n: 7 }),
          update(3, { n: 99 }, "owned"),
        ),
      )
      const [first, second, missing, fourth] = result
      expect(first && "result" in first && [first.result.matched, first.result.modified]).toEqual([
        1, 0,
      ])
      expect(
        second && "result" in second && [second.result.matched, second.result.modified],
      ).toEqual([1, 1])
      expect(missing && "result" in missing && missing.result.matched).toBe(0)
      expect(missing && "result" in missing && missing.result.documents).toBeUndefined()
      expect(documentsOf(fourth)).toEqual([
        { _id: { $numberInt: "3" }, ownerId: "alice", n: { $numberInt: "99" } },
      ])
    })

    it("answers a failed precondition as a conflict on a visible document and not found on another's", async () => {
      await seedBoth("owned", [
        { _id: 1, ownerId: "alice", v: 1 },
        { _id: 2, ownerId: "bob", v: 1 },
        { _id: 3, ownerId: "alice", v: 1 },
      ])
      const result = await writes.executeEach(
        alice,
        items(
          { ...update(1, { v: 2 }), where: { v: 5 } } as WriteRequest,
          { ...update(2, { v: 2 }), where: { v: 5 } } as WriteRequest,
          update(3, { v: 3 }),
        ),
      )
      expect(result[0] && "error" in result[0] && result[0].error.code).toBe(ErrorCode.Conflict)
      expect(result[1] && "result" in result[1] && result[1].result.matched).toBe(0)
      expect(result[2] && "result" in result[2] && result[2].result.modified).toBe(1)
      expect(
        (await db.collection("owned").find({}).sort({ _id: 1 }).toArray()).map((d) => d["v"]),
      ).toEqual([1, 1, 3])
    })

    it("refuses an insert that fails the check and carries on with the others", async (ctx) => {
      if (!grouping) ctx.skip()
      const { value, names } = await commands(() =>
        writes.executeEach(
          alice,
          items(
            insert({ _id: 1, ownerId: "alice" }),
            insert({ _id: 2, ownerId: "bob" }),
            insert({ _id: 3, ownerId: "alice" }),
          ),
        ),
      )
      expect(value.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
        "ok",
        ErrorCode.PolicyViolation,
        "ok",
      ])
      expect(names).toEqual(["aggregate", "bulkWrite"])
      expect((await db.collection("owned").find({}).toArray()).map((d) => d["_id"])).toEqual([1, 3])
    })

    it("never returns or changes the documents of another owner", async () => {
      await seedBoth("owned", [
        { _id: 1, ownerId: "alice" },
        { _id: 2, ownerId: "bob", secret: "b" },
        { _id: 3, ownerId: "alice", hidden: true },
        { _id: 4, ownerId: "alice" },
      ])
      const result = await writes.executeEach(
        alice,
        items(
          update(1, { n: 1 }),
          update(2, { n: 1 }),
          update(3, { n: 1 }),
          replace(4, { ownerId: "alice", hidden: true }),
          replace(2, { ownerId: "alice" }),
        ),
      )
      expect(result.map((item) => ("result" in item ? item.result.matched : -1))).toEqual([
        1, 0, 0, 1, 0,
      ])
      expect(documentsOf(result[3])).toEqual([null])
      expect(await db.collection("owned").findOne({ _id: 2 as never })).toEqual({
        _id: 2,
        ownerId: "bob",
        secret: "b",
      })
    })

    it("keeps the cluster time of a group at or after the change event of each of its writes", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("owned", owners())
      const stream = db.collection("owned").watch([])
      try {
        await stream.tryNext()
        const result = await writes.executeEach(
          alice,
          items(update(1, { n: 21 }), update(2, { n: 22 }), update(3, { n: 23 })),
        )
        const times: bigint[] = []
        for (let seen = 0; seen < 3; seen++) {
          const event = (await stream.next()) as ChangeStreamDocument
          times.push(BigInt(toCt(event.clusterTime) ?? "0"))
        }
        const cts = result.map((item) => ("result" in item ? BigInt(item.result.ct) : 0n))
        expect(new Set(cts).size).toBe(1)
        for (const time of times) expect(cts[0] ?? 0n).toBeGreaterThanOrEqual(time)
        expect(cts[0]).toBe(times[2])
      } finally {
        await stream.close()
      }
    })
  })

  describe("when MongoDB refuses a write of a group", () => {
    it("reports its error as the write alone has it and goes on with the writes after it", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("keyed", [
        { _id: 1, ownerId: "alice", email: "a@x" },
        { _id: 2, ownerId: "alice", email: "b@x" },
      ])
      const batch = items(
        update(1, { n: 1 }, "keyed"),
        insert({ _id: 3, ownerId: "alice", email: "b@x" }, "keyed"),
        insert({ _id: 4, ownerId: "alice", email: "d@x" }, "keyed"),
        update(2, { n: 2 }, "keyed"),
      )
      const { value, names } = await commands(() => writes.executeEach(service, batch))
      const want = await oneAtATime(service, batch)
      for (const [index, item] of value.entries())
        expect(describeItem(item), `operation ${index}`).toBe(describeItem(want[index] as never))
      const failed = value[1]
      expect(failed && "error" in failed && failed.error.code).toBe(ErrorCode.DuplicateKey)
      expect(failed && "error" in failed && failed.error.details).toEqual({
        keyValue: { email: "b@x" },
      })
      expect(names.filter((name) => name === "bulkWrite")).toHaveLength(2)
      expect(
        (await db.collection("keyed").find({}).sort({ _id: 1 }).toArray()).map((d) => d["_id"]),
      ).toEqual([1, 2, 4])
    })

    it("hides the duplicated key from a caller who is not service, as the write alone does", async () => {
      await seedBoth("keyed", [{ _id: 1, ownerId: "alice", email: "a@x" }])
      const result = await writes.executeEach(
        alice,
        items(
          insert({ _id: 2, ownerId: "alice", email: "n@x" }, "keyed"),
          insert({ _id: 3, ownerId: "alice", email: "a@x" }, "keyed"),
        ),
      )
      expect(result[1] && "error" in result[1] && result[1].error.code).toBe(ErrorCode.DuplicateKey)
      expect(result[1] && "error" in result[1] && result[1].error.details).toBeUndefined()
    })

    it("falls back to one write at a time on a server that has no bulkWrite command", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("owned", owners())
      const engine = testPolicyEngine(createPolicySet([owned]))
      const fresh = new WritePath({
        client,
        database: dbName,
        metaDatabase: `${dbName}_meta`,
        policies: engine,
      })
      const spy = vi
        .spyOn(client, "bulkWrite")
        .mockRejectedValueOnce(new MongoServerError({ message: "no such command", code: 59 }))
      try {
        const result = await fresh.executeEach(
          alice,
          items(update(1, { n: 31 }), update(2, { n: 32 }), update(3, { n: 33 })),
        )
        expect(result.map((item) => ("result" in item ? item.result.modified : -1))).toEqual([
          1, 1, 1,
        ])
        expect(documentsOf(result[1])).toEqual([
          { _id: { $numberInt: "2" }, ownerId: "alice", n: { $numberInt: "32" } },
        ])
        const again = await commands(() =>
          fresh.executeEach(alice, items(update(1, { n: 41 }), update(2, { n: 42 }))),
        )
        expect(again.names).toEqual(["update", "find", "update", "find"])
        expect(spy).toHaveBeenCalledTimes(1)
      } finally {
        spy.mockRestore()
      }
    })

    it("reports an error to every write of a group when the command fails as a whole", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("owned", owners())
      const spy = vi
        .spyOn(client, "bulkWrite")
        .mockRejectedValueOnce(new MongoNetworkError("connection lost"))
      try {
        const result = await writes.executeEach(
          alice,
          items(update(1, { n: 31 }), update(2, { n: 32 })),
        )
        expect(result.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
          ErrorCode.Unavailable,
          ErrorCode.Unavailable,
        ])
      } finally {
        spy.mockRestore()
      }
    })

    it("reports a write concern error to every write the group applied, as each write alone reports it", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("owned", owners())
      const real = client.bulkWrite.bind(client)
      const spy = vi.spyOn(client, "bulkWrite").mockImplementationOnce((async (
        models: Parameters<typeof real>[0],
        options?: Parameters<typeof real>[1],
      ) => {
        const partialResult = await real(models, options)
        const error = new MongoClientBulkWriteError({
          message: "waiting for replication timed out",
          code: 64,
        })
        error.writeConcernErrors = [{ code: 64, message: "waiting for replication timed out" }]
        error.partialResult = partialResult
        throw error
      }) as typeof real)
      try {
        const result = await writes.executeEach(
          alice,
          items(update(1, { n: 51 }), update(2, { n: 52 })),
        )
        expect(spy).toHaveBeenCalledTimes(1)
        expect(result.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
          ErrorCode.Internal,
          ErrorCode.Internal,
        ])
        const stored = await db
          .collection("owned")
          .find({ _id: { $in: [1, 2] } } as Document)
          .sort({ _id: 1 })
          .toArray()
        expect(stored.map((doc) => doc["n"])).toEqual([51, 52])
      } finally {
        spy.mockRestore()
      }
    })

    it("reports a validator failure at its place", async () => {
      const batch = items(
        insert({ _id: 1, ownerId: "alice", label: "ok" }, "checked"),
        insert({ _id: 2, ownerId: "alice", label: 5 }, "checked"),
        insert({ _id: 3, ownerId: "alice", label: "ok" }, "checked"),
      )
      const result = await writes.executeEach(alice, batch)
      expect(result.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
        "ok",
        ErrorCode.ValidationFailed,
        "ok",
      ])
    })
  })

  describe("which writes it keeps apart", () => {
    it("runs two writes on one document in order, each reading back its own state", async () => {
      await seedBoth("things", [{ _id: 1 }, { _id: 2 }, { _id: 3 }])
      const result = await writes.executeEach(
        alice,
        items(
          update(1, { v: "one" }, "things"),
          update(2, { v: "x" }, "things"),
          update(1, { v: "two" }, "things"),
          update(3, { v: "y" }, "things"),
        ),
      )
      expect(result.map(documentsOf)).toEqual([
        [{ _id: { $numberInt: "1" }, v: "one" }],
        [{ _id: { $numberInt: "2" }, v: "x" }],
        [{ _id: { $numberInt: "1" }, v: "two" }],
        [{ _id: { $numberInt: "3" }, v: "y" }],
      ])
    })

    it("treats numbers of different BSON types as one document", async (ctx) => {
      if (!grouping) ctx.skip()
      await seedBoth("things", [{ _id: 1 }, { _id: 2 }])
      const { value, names } = await commands(() =>
        writes.executeEach(
          alice,
          items(
            update(1, { v: "int" }, "things"),
            update(new Long(1), { v: "long" }, "things"),
            update(1.0, { v: "double" }, "things"),
            update(2, { v: "other" }, "things"),
          ),
        ),
      )
      expect(value.map(documentsOf)).toEqual([
        [{ _id: { $numberInt: "1" }, v: "int" }],
        [{ _id: { $numberInt: "1" }, v: "long" }],
        [{ _id: { $numberInt: "1" }, v: "double" }],
        [{ _id: { $numberInt: "2" }, v: "other" }],
      ])
      expect(names.filter((name) => name === "bulkWrite")).toHaveLength(1)
    })

    it("reads back a document stored with another numeric type than the one written", async () => {
      await seedBoth("things", [{ _id: new BSON.Long(5) }, { _id: new BSON.Double(6) }, { _id: 7 }])
      const result = await writes.executeEach(
        alice,
        items(
          update(5, { v: 1 }, "things"),
          update(6, { v: 2 }, "things"),
          update(new Long(7), { v: 3 }, "things"),
        ),
      )
      expect(result.map(documentsOf)).toEqual([
        [{ _id: { $numberLong: "5" }, v: { $numberInt: "1" } }],
        [{ _id: { $numberDouble: "6.0" }, v: { $numberInt: "2" } }],
        [{ _id: { $numberInt: "7" }, v: { $numberInt: "3" } }],
      ])
    })

    it("treats strings that a collation makes equal as one document", async () => {
      await seedBoth("folded", [{ _id: "abc" }, { _id: "other" }])
      const { value } = await commands(() =>
        writes.executeEach(
          alice,
          items(
            update("ABC", { v: 1 }, "folded"),
            update("other", { v: 2 }, "folded"),
            update("abc", { v: 3 }, "folded"),
          ),
        ),
      )
      expect(value.map(documentsOf)).toEqual([
        [{ _id: "abc", v: { $numberInt: "1" } }],
        [{ _id: "other", v: { $numberInt: "2" } }],
        [{ _id: "abc", v: { $numberInt: "3" } }],
      ])
    })

    it("groups ObjectIds and strings of one collection", async (ctx) => {
      if (!grouping) ctx.skip()
      const first = new BSON.ObjectId()
      const second = new BSON.ObjectId()
      await seedBoth("things", [{ _id: first }, { _id: second }, { _id: "s" }])
      const { value, names } = await commands(() =>
        writes.executeEach(
          alice,
          items(
            update(new WireObjectId(first.toHexString()), { v: 1 }, "things"),
            update(new WireObjectId(second.toHexString()), { v: 2 }, "things"),
            update("s", { v: 3 }, "things"),
          ),
        ),
      )
      expect(value.every((item) => "result" in item)).toBe(true)
      expect(names).toEqual(["bulkWrite", "find"])
    })

    it("does not group a write that needs a transaction", async () => {
      await seedBoth("guarded", [
        { _id: 1, ownerId: "alice", n: 1 },
        { _id: 2, ownerId: "alice", n: 1 },
      ])
      const { value, names } = await commands(() =>
        writes.executeEach(
          alice,
          items(update(1, { n: 2 }, "guarded"), update(2, { n: 99 }, "guarded")),
        ),
      )
      expect(value.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
        "ok",
        ErrorCode.PolicyViolation,
      ])
      expect(names).not.toContain("bulkWrite")
    })

    it("stops every operation when the request is aborted, as each would alone", async () => {
      await seedBoth("owned", owners())
      const controller = new AbortController()
      controller.abort()
      const result = await writes.executeEach(
        alice,
        items(update(1, { n: 5 }), update(2, { n: 5 })),
        {
          signal: controller.signal,
        },
      )
      expect(result.map((item) => ("error" in item ? item.error.code : "ok"))).toEqual([
        ErrorCode.Timeout,
        ErrorCode.Timeout,
      ])
      expect(
        (await db.collection("owned").find({}).sort({ _id: 1 }).limit(2).toArray()).map(
          (d) => d["n"],
        ),
      ).toEqual([1, 2])
    })
  })

  describe("against one operation at a time", () => {
    it("reports and stores what each generated batch does when its operations run alone", async (ctx) => {
      if (!grouping) ctx.skip()
      const callers = [alice, bob, service]
      const runs = Number(process.env["CANOPY_DIFF_RUNS"] ?? 80)
      const ids: unknown[] = [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        9,
        new Long(2),
        3.0,
        new WireObjectId("a".repeat(24)),
      ]
      const strings = ["s1", "s2", "s3", "ABC", "abc"]
      let groups = 0
      let operations = 0
      let refused = 0
      const kinds = new Set<string>()
      for (let seed = 1; seed <= runs; seed++) {
        const next = random(seed)
        const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T
        for (const target of [db, oracleDb])
          for (const name of NAMES) await target.collection(name).deleteMany({})
        for (const name of ["owned", "things", "guarded", "keyed", "checked"]) {
          const seeded: Document[] = [1, 2, 3, 4, 5, 6].map((id) => ({
            _id: id,
            ownerId: id % 2 === 0 ? "alice" : "bob",
            n: id + Math.floor(next() * 8),
            secret: "x",
            ...(id === 5 ? { hidden: true } : {}),
            ...(name === "keyed" ? { email: `e${id}` } : {}),
          }))
          seeded.push({ _id: new BSON.ObjectId("a".repeat(24)), ownerId: "alice", n: 1 })
          await seedBoth(name, seeded)
        }
        await seedBoth(
          "folded",
          strings.slice(0, 4).map((id) => ({ _id: id, ownerId: "alice" })),
        )
        const caller = pick(callers)
        const batch: BatchItem[] = []
        const size = 2 + Math.floor(next() * 7)
        let fresh = 0
        for (let index = 0; index < size; index++) {
          const name = pick(["owned", "owned", "things", "guarded", "keyed", "checked", "folded"])
          const owner = pick(["alice", "alice", "bob"])
          const set: Document = pick([
            { n: Math.floor(next() * 20) },
            { hidden: next() < 0.5 },
            { t: index },
          ])
          const id = name === "folded" ? pick(strings) : pick(ids)
          const where = next() < 0.12 ? { where: { n: { $gte: 8 } } } : {}
          const kind = pick([
            "update",
            "update",
            "update",
            "insert",
            "insert",
            "replace",
            "replace",
            "delete",
            ...(next() < 0.15 ? ["updateMany", "upsert", "insertMany"] : []),
          ])
          let request: WriteRequest
          switch (kind) {
            case "insert":
              request = insert(
                {
                  _id: next() < 0.2 ? pick(ids) : `new${seed}_${fresh++}`,
                  ownerId: owner,
                  ...set,
                  ...(name === "keyed" ? { email: pick(["e1", "e9", `f${fresh}`]) } : {}),
                  ...(name === "checked" ? { label: pick(["ok", "ok", 7]) } : {}),
                },
                name,
              )
              break
            case "replace":
              request = replace(
                id,
                {
                  ownerId: owner,
                  ...set,
                  ...(name === "keyed" ? { email: pick(["e1", "e9", `g${index}`]) } : {}),
                  ...(name === "checked" ? { label: pick(["ok", "ok", 7]) } : {}),
                },
                name,
                where,
              )
              break
            case "upsert":
              request = replace(pick([8, 9, 10]), { ownerId: owner, ...set }, name, {
                upsert: true,
              })
              break
            case "delete":
              request = { op: "delete", collection: name, id, ...where } as WriteRequest
              break
            case "updateMany":
              request = {
                op: "updateMany",
                collection: name,
                filter: { n: { $gte: Math.floor(next() * 10) } },
                update: { $set: set },
                bulk: true,
              }
              break
            case "insertMany":
              request = {
                op: "insertMany",
                collection: name,
                docs: [{ _id: `many${seed}_${fresh++}`, ownerId: owner }],
              }
              break
            default:
              request = { ...update(id, set, name), ...where } as WriteRequest
          }
          const mutationId = next() < 0.1 ? `mutation-${seed}-${index}` : undefined
          batch.push(mutationId === undefined ? { request } : { request, mutationId })
        }
        const { value, names } = await commands(() => writes.executeEach(caller, batch))
        const want = await oneAtATime(caller, batch)
        groups += names.filter((name) => name === "bulkWrite").length
        operations += batch.length
        for (const [index, item] of value.entries()) {
          expect(describeItem(item), `seed ${seed} operation ${index}`).toBe(
            describeItem(want[index] as BatchItemResult),
          )
          kinds.add("error" in item ? item.error.code : "ok")
          if ("error" in item) refused += 1
        }
        expect(value).toHaveLength(batch.length)
        for (const name of NAMES) {
          const a = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
          const b = await oracleDb.collection(name).find({}).sort({ _id: 1 }).toArray()
          expect(exact(a), `seed ${seed} ${name}`).toBe(exact(b))
        }
      }
      expect(operations).toBeGreaterThan(300)
      expect(groups).toBeGreaterThan(40)
      expect(refused).toBeGreaterThan(20)
      for (const code of [
        "ok",
        ErrorCode.PolicyViolation,
        ErrorCode.Conflict,
        ErrorCode.DuplicateKey,
        ErrorCode.ValidationFailed,
      ])
        expect(kinds.has(code), code).toBe(true)
    }, 1_800_000)
  })
})
