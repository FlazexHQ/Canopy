import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { isClusterTime } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Caller, type WriteEvent, WritePath } from "../src/index.ts"

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const notes = collection("notes", {
  exposed: true,
  policies: [allow.read("authenticated"), allow.insert("authenticated")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

const alice: Caller = {
  context: {
    roles: new Set(["authenticated", "editor"]),
    claims: { sub: "alice" },
    now: new Date(),
  },
  subject: "alice",
}

suite("WritePath onWrite", () => {
  const dbName = `canopy_rest_events_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let client: MongoClient
  let db: Db
  let writes: WritePath
  let throwing: WritePath
  const events: WriteEvent[] = []

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    const policies = new PolicyEngine(createPolicySet([todos, notes]))
    const shared = { client, database: dbName, metaDatabase: metaName, policies }
    writes = new WritePath({ ...shared, onWrite: (event) => events.push(event) })
    throwing = new WritePath({
      ...shared,
      onWrite: () => {
        throw new Error("observer failed")
      },
    })
    await writes.ensureIndexes()
    for (const name of ["todos", "notes"]) await db.createCollection(name)
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    events.length = 0
    await db.collection("todos").deleteMany({})
    await db.collection("notes").deleteMany({})
  })

  it("reports a fast path insert with the subject, sorted roles, ids and cluster time", async () => {
    const result = await writes.execute(alice, {
      op: "insert",
      collection: "notes",
      doc: { _id: "n1", text: "hi" },
    })
    expect(events).toHaveLength(1)
    const [event] = events
    expect(event).toMatchObject({
      subject: "alice",
      roles: ["authenticated", "editor"],
      collection: "notes",
      op: "insert",
      ids: ["n1"],
    })
    expect(event?.mutationId).toBeUndefined()
    expect(isClusterTime(event?.ct)).toBe(true)
    expect(event?.ct).toEqual(result.ct)
  })

  it("reports a transactional write with its mutation ID once, and not its replay", async () => {
    const request = {
      op: "insert" as const,
      collection: "todos",
      doc: { _id: "t1", ownerId: "alice" },
    }
    const first = await writes.execute(alice, request, { mutationId: "mutation-0001" })
    const again = await writes.execute(alice, request, { mutationId: "mutation-0001" })
    expect(again.replayed).toBe(true)
    expect(events).toEqual([
      expect.objectContaining({
        op: "insert",
        collection: "todos",
        ids: ["t1"],
        mutationId: "mutation-0001",
        ct: first.ct,
      }),
    ])
  })

  it("reports each operation of a batch, and the ids a bulk write changed", async () => {
    await db.collection("todos").insertMany([
      { _id: "a" as never, ownerId: "alice", done: false },
      { _id: "b" as never, ownerId: "alice", done: false },
      { _id: "c" as never, ownerId: "bob", done: false },
    ])
    await writes.executeBatch(alice, [
      { op: "insert", collection: "todos", doc: { _id: "d", ownerId: "alice" } },
      { op: "delete", collection: "todos", id: "a" },
    ])
    await writes.execute(alice, {
      op: "updateMany",
      collection: "todos",
      filter: {},
      update: { $set: { done: true } },
      bulk: true,
    })
    expect(events.map((event) => [event.op, [...event.ids].sort()])).toEqual([
      ["insert", ["d"]],
      ["delete", ["a"]],
      ["updateMany", ["b", "d"]],
    ])
  })

  it("reports nothing for refused writes or writes that changed nothing", async () => {
    await expect(
      writes.execute(alice, {
        op: "insert",
        collection: "todos",
        doc: { _id: "x", ownerId: "bob" },
      }),
    ).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    await writes.execute(alice, { op: "delete", collection: "todos", id: "missing" })
    expect(events).toEqual([])
  })

  it("keeps the write when the observer throws", async () => {
    const result = await throwing.execute(alice, {
      op: "insert",
      collection: "notes",
      doc: { _id: "n2" },
    })
    expect(result.insertedIds).toEqual(["n2"])
    expect(await db.collection("notes").countDocuments({ _id: "n2" as never })).toBe(1)
  })
})
