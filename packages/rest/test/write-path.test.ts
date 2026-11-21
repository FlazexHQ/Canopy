import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import { CanopyError, ErrorCode, isClusterTime, ObjectId as WireObjectId } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { BSON, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Caller, WritePath, type WriteRequest, type WriteResult } from "../src/index.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("read own"),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub") })
      .named("create own"),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .named("edit own"),
    allow
      .delete("authenticated")
      .where({ ownerId: auth("sub") })
      .named("delete own"),
    restrict
      .delete("authenticated")
      .where({ archived: { $ne: true } })
      .named("archived is permanent"),
  ],
  fields: {
    read: { default: { omit: ["internalNotes"] } },
    write: {
      default: { only: ["title", "done", "count", "tags", "ownerId", "profile.name", "createdAt"] },
    },
  },
  immutable: ["createdAt"],
})

const boards = collection("boards", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), count: { $lte: 3 } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({
        ownerId: auth("sub"),
        count: { $lte: 3 },
      }),
  ],
})

const plain = collection("plain", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const inbox = collection("inbox", {
  exposed: true,
  policies: [allow.insert("authenticated").check({ to: { $exists: true } })],
})

const hidden = collection("hidden", { exposed: false, policies: [allow.read("authenticated")] })

const notes = collection("notes", {
  exposed: true,
  policies: [
    allow.read("editor"),
    allow.insert("editor"),
    allow.update("editor"),
    allow.delete("editor"),
    allow.read("teamlead").where({ team: auth("team") }),
    allow
      .update("teamlead")
      .where({ team: auth("team") })
      .check({}),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const orders = collection("orders", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
  immutable: ["lines.sku"],
})

const slots = collection("slots", {
  exposed: true,
  policies: [
    allow.read("writer").where({ public: true }),
    allow.update("writer"),
    allow.delete("writer"),
    allow.read("checker").where({ public: true }),
    allow.update("checker").check({ n: { $lt: 100 } }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

/** Relaxed EJSON, so exact BSON values (Int32 and friends) compare equal to plain literals. */
function relaxed(value: unknown): unknown {
  return JSON.parse(BSON.EJSON.stringify(value, { relaxed: true }))
}

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

const editor: Caller = {
  context: { roles: new Set(["authenticated", "editor"]), claims: { sub: "ed" }, now: new Date() },
  subject: "ed",
}

const writer: Caller = {
  context: { roles: new Set(["authenticated", "writer"]), claims: { sub: "w" }, now: new Date() },
  subject: "w",
}

const checker: Caller = {
  context: { roles: new Set(["authenticated", "checker"]), claims: { sub: "c" }, now: new Date() },
  subject: "c",
}

const anon: Caller = {
  context: { roles: new Set(["anon"]), claims: null, now: new Date() },
  subject: "anon",
}

async function failure(promise: Promise<unknown>): Promise<CanopyError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof CanopyError) return error
    throw error
  }
  throw new Error("expected the write to fail")
}

suite("WritePath against MongoDB", () => {
  const dbName = `canopy_rest_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let client: MongoClient
  let db: Db
  let writes: WritePath
  const alice = user("alice")
  const bob = user("bob")

  const coll = (name: string) => db.collection<{ _id: unknown; [key: string]: unknown }>(name)

  const byId = (name: string, id: unknown): Promise<Document | null> =>
    db.collection(name).findOne({ _id: id } as Document)

  const docs = (name: string): Promise<Document[]> => coll(name).find({}).sort({ _id: 1 }).toArray()

  const run = (caller: Caller, request: WriteRequest, mutationId?: string): Promise<WriteResult> =>
    writes.execute(caller, request, mutationId === undefined ? {} : { mutationId })

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    await client.connect()
    db = client.db(dbName)
    const engine = testPolicyEngine(
      createPolicySet([todos, boards, plain, inbox, hidden, notes, slots, orders]),
    )
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: metaName,
      policies: engine,
      limits: { maxBulk: 3, maxInsertMany: 5 },
    })
    await writes.ensureIndexes()
    for (const name of ["todos", "boards", "plain", "inbox", "hidden", "notes", "slots", "orders"])
      await db.createCollection(name)
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    for (const name of ["todos", "boards", "plain", "inbox", "hidden", "notes", "slots", "orders"])
      await coll(name).deleteMany({})
    await client.db(metaName).collection("mutations").deleteMany({})
  })

  describe("insert", () => {
    it("inserts an allowed document and returns the readable post image with a cluster time", async () => {
      const result = await run(alice, {
        op: "insert",
        collection: "todos",
        doc: { _id: 1, title: "t", ownerId: "alice" },
      })
      expect(relaxed(result)).toMatchObject({ insertedIds: [1], changedIds: [1], replayed: false })
      expect(isClusterTime(result.ct)).toBe(true)
      expect(relaxed(result.documents)).toEqual([{ _id: 1, title: "t", ownerId: "alice" }])
      expect(await docs("todos")).toEqual([{ _id: 1, title: "t", ownerId: "alice" }])
    })

    it("generates an ObjectId when no _id is given", async () => {
      const result = await run(alice, {
        op: "insert",
        collection: "todos",
        doc: { title: "t", ownerId: "alice" },
      })
      expect(result.insertedIds[0]).toBeInstanceOf(BSON.ObjectId)
    })

    it("stores _id as the first field and keeps the order of the others", async () => {
      const result = await run(alice, {
        op: "insertMany",
        collection: "todos",
        docs: [
          { title: "a", ownerId: "alice", _id: 7 },
          { done: false, title: "b", ownerId: "alice" },
        ],
      })
      const stored = await coll("todos")
        .find({}, { sort: { title: 1 } })
        .toArray()
      expect(stored.map((doc) => Object.keys(doc))).toEqual([
        ["_id", "title", "ownerId"],
        ["_id", "done", "title", "ownerId"],
      ])
      expect(result.insertedIds[0]).toBe(7)
      expect(result.insertedIds[1]).toBeInstanceOf(BSON.ObjectId)
      expect(stored[1]?.["_id"]).toEqual(result.insertedIds[1])
      expect(result.documents?.map((doc) => Object.keys(doc ?? {}))).toEqual([
        ["_id", "title", "ownerId"],
        ["_id", "done", "title", "ownerId"],
      ])
    })

    it("rejects a document that fails CHECK(insert) and leaves nothing behind", async () => {
      const error = await failure(
        run(alice, { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "bob" } }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect(await docs("todos")).toEqual([])
    })

    it("rejects fields outside the write rules, including nested ones", async () => {
      for (const doc of [
        { _id: 1, ownerId: "alice", internalNotes: "x" },
        { _id: 2, ownerId: "alice", profile: { name: "a", ssn: "1" } },
        { _id: 3, ownerId: "alice", profile: {} },
      ]) {
        const error = await failure(run(alice, { op: "insert", collection: "todos", doc }))
        expect(error.code).toBe(ErrorCode.PolicyViolation)
      }
      await run(alice, {
        op: "insert",
        collection: "todos",
        doc: { _id: 4, ownerId: "alice", profile: { name: "a" } },
      })
      expect((await docs("todos")).map((doc) => doc["_id"])).toEqual([4])
    })

    it("allows immutable fields on insert", async () => {
      const result = await run(alice, {
        op: "insert",
        collection: "todos",
        doc: { _id: 1, ownerId: "alice", createdAt: new Date(0) },
      })
      expect(relaxed(result.documents)).toEqual(
        relaxed([{ _id: 1, ownerId: "alice", createdAt: new Date(0) }]),
      )
    })

    it("inserts many atomically: one failing check aborts the batch", async () => {
      const error = await failure(
        run(alice, {
          op: "insertMany",
          collection: "todos",
          docs: [
            { _id: 1, ownerId: "alice" },
            { _id: 2, ownerId: "bob" },
          ],
        }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect(await docs("todos")).toEqual([])
      const ok = await run(alice, {
        op: "insertMany",
        collection: "todos",
        docs: [
          { _id: 1, ownerId: "alice" },
          { _id: 2, ownerId: "alice" },
        ],
      })
      expect(ok.insertedIds).toEqual([1, 2])
      expect(relaxed(ok.documents)).toEqual([
        { _id: 1, ownerId: "alice" },
        { _id: 2, ownerId: "alice" },
      ])
    })

    it("caps insertMany", async () => {
      const many = Array.from({ length: 6 }, (_, i) => ({ _id: i, ownerId: "alice" }))
      const error = await failure(run(alice, { op: "insertMany", collection: "todos", docs: many }))
      expect(error.code).toBe(ErrorCode.BulkLimit)
    })

    it("returns null for a document the caller cannot read (drop box)", async () => {
      const result = await run(alice, {
        op: "insert",
        collection: "inbox",
        doc: { _id: 1, to: "x" },
      })
      expect(result.documents).toEqual([null])
      expect(await docs("inbox")).toHaveLength(1)
    })

    it("refuses callers without a grant, unexposed collections and duplicate keys", async () => {
      expect(
        (await failure(run(anon, { op: "insert", collection: "todos", doc: { ownerId: "x" } })))
          .code,
      ).toBe(ErrorCode.Forbidden)
      expect(
        (await failure(run(alice, { op: "insert", collection: "hidden", doc: { a: 1 } }))).code,
      ).toBe(ErrorCode.NotFound)
      expect(
        (await failure(run(alice, { op: "insert", collection: "nope", doc: { a: 1 } }))).code,
      ).toBe(ErrorCode.NotFound)
      await run(alice, { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } })
      const dup = await failure(
        run(alice, { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } }),
      )
      expect(dup.code).toBe(ErrorCode.DuplicateKey)
      expect(dup.details).toBeUndefined()
    })

    it("rejects $ prefixed and dotted keys and prototype keys", async () => {
      for (const doc of [
        { _id: 1, ownerId: "alice", $set: 1 },
        { _id: 2, ownerId: "alice", "a.b": 1 },
        JSON.parse('{"_id":3,"ownerId":"alice","__proto__":{"x":1}}') as unknown,
      ]) {
        const error = await failure(run(alice, { op: "insert", collection: "plain", doc }))
        expect(error.code).toBe(ErrorCode.InvalidQuery)
      }
      expect(await docs("plain")).toEqual([])
    })
  })

  describe("update", () => {
    beforeEach(async () => {
      await coll("todos").insertMany([
        { _id: 1, ownerId: "alice", title: "a", count: 1, internalNotes: "n", createdAt: 1 },
        { _id: 2, ownerId: "bob", title: "b", count: 1 },
      ])
    })

    it("updates a visible document and returns the readable post image", async () => {
      const result = await run(alice, {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $set: { done: true }, $inc: { count: 2 } },
      })
      expect(relaxed(result)).toMatchObject({ matched: 1, modified: 1, changedIds: [1] })
      expect(relaxed(result.documents)).toEqual([
        { _id: 1, ownerId: "alice", title: "a", count: 3, done: true, createdAt: 1 },
      ])
    })

    it("leaves invisible documents untouched and reports nothing matched", async () => {
      const result = await run(alice, {
        op: "update",
        collection: "todos",
        id: 2,
        update: { $set: { title: "hijacked" } },
      })
      expect(result).toMatchObject({ matched: 0, modified: 0, changedIds: [] })
      expect((await docs("todos"))[1]?.["title"]).toBe("b")
    })

    it("reports matched but not modified for a no-op update", async () => {
      const result = await run(alice, {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $set: { title: "a" } },
      })
      expect(result).toMatchObject({ matched: 1, modified: 0, changedIds: [] })
    })

    it("refuses to move a document out of the caller scope (check defaults to using)", async () => {
      const error = await failure(
        run(alice, {
          op: "update",
          collection: "todos",
          id: 1,
          update: { $set: { ownerId: "bob" } },
        }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect((await docs("todos"))[0]?.["ownerId"]).toBe("alice")
    })

    it("lets MongoDB evaluate the check on the real post image", async () => {
      await coll("boards").insertOne({ _id: 1, ownerId: "alice", count: 2 })
      await run(alice, {
        op: "update",
        collection: "boards",
        id: 1,
        update: { $inc: { count: 1 } },
      })
      const error = await failure(
        run(alice, { op: "update", collection: "boards", id: 1, update: { $inc: { count: 1 } } }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect((await docs("boards"))[0]?.["count"]).toBe(3)
      const pushed = await failure(
        run(alice, {
          op: "update",
          collection: "boards",
          id: 1,
          update: { $max: { count: 10 } },
        }),
      )
      expect(pushed.code).toBe(ErrorCode.PolicyViolation)
    })

    it("rejects writes to unwritable, hidden and immutable fields, through every operator", async () => {
      const updates: Document[] = [
        { $set: { internalNotes: "x" } },
        { $unset: { internalNotes: "" } },
        { $rename: { title: "internalNotes" } },
        { $rename: { internalNotes: "title" } },
        { $set: { profile: { name: "a", ssn: 1 } } },
        { $set: { "profile.ssn": 1 } },
        { $set: { createdAt: 2 } },
        { $currentDate: { createdAt: true } },
        { $push: { "internalNotes.$[]": 1 } },
      ]
      for (const update of updates) {
        const error = await failure(
          run(alice, { op: "update", collection: "todos", id: 1, update }),
        )
        expect([ErrorCode.PolicyViolation, ErrorCode.InvalidQuery]).toContain(error.code)
      }
      const [stored] = await docs("todos")
      expect(stored).toEqual({
        _id: 1,
        ownerId: "alice",
        title: "a",
        count: 1,
        internalNotes: "n",
        createdAt: 1,
      })
    })

    it("applies immutable fields to every element of an array", async () => {
      await coll("orders").insertOne({
        _id: 1,
        ownerId: "alice",
        lines: [
          { sku: "a", qty: 1 },
          { sku: "b", qty: 2 },
        ],
      })
      const updates: Document[] = [
        { $set: { "lines.0.sku": "x" } },
        { $set: { "lines.$[].sku": "x" } },
        { $set: { "lines.1": { sku: "x", qty: 2 } } },
        { $unset: { "lines.0.sku": "" } },
      ]
      for (const update of updates) {
        const error = await failure(
          run(alice, { op: "update", collection: "orders", id: 1, update }),
        )
        expect(error.code).toBe(ErrorCode.PolicyViolation)
      }
      const allowed = await run(alice, {
        op: "update",
        collection: "orders",
        id: 1,
        update: { $inc: { "lines.0.qty": 1 } },
      })
      expect(allowed.modified).toBe(1)
      expect((await byId("orders", 1))?.["lines"]).toEqual([
        { sku: "a", qty: 2 },
        { sku: "b", qty: 2 },
      ])
    })

    it("lets service change anything, including immutable fields", async () => {
      const result = await run(service, {
        op: "update",
        collection: "todos",
        id: 2,
        update: { $set: { createdAt: 5, internalNotes: "svc" } },
      })
      expect(result.modified).toBe(1)
      expect(relaxed(result.documents?.[0])).toMatchObject({ internalNotes: "svc", createdAt: 5 })
    })

    it("rejects replacement documents and pipeline updates from non service callers", async () => {
      expect(
        (await failure(run(alice, { op: "update", collection: "todos", id: 1, update: { a: 1 } })))
          .code,
      ).toBe(ErrorCode.InvalidQuery)
      expect(
        (
          await failure(
            run(alice, { op: "update", collection: "todos", id: 1, update: [{ $set: { a: 1 } }] }),
          )
        ).code,
      ).toBe(ErrorCode.InvalidQuery)
    })

    it("fails a where precondition on a visible document with a conflict", async () => {
      const error = await failure(
        run(alice, {
          op: "update",
          collection: "todos",
          id: 1,
          update: { $set: { done: true } },
          where: { title: "other" },
        }),
      )
      expect(error.code).toBe(ErrorCode.Conflict)
      const ok = await run(alice, {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $set: { done: true } },
        where: { title: "a" },
      })
      expect(ok.modified).toBe(1)
    })

    it("treats a failed precondition on an invisible document as not found, not a conflict", async () => {
      const result = await run(alice, {
        op: "update",
        collection: "todos",
        id: 2,
        update: { $set: { done: true } },
        where: { title: "other" },
      })
      expect(result.matched).toBe(0)
    })

    it("rejects filters and preconditions that reference unreadable fields", async () => {
      const where = await failure(
        run(alice, {
          op: "update",
          collection: "todos",
          id: 1,
          update: { $set: { done: true } },
          where: { internalNotes: "n" },
        }),
      )
      expect(where.code).toBe(ErrorCode.InvalidQuery)
      const filter = await failure(
        run(alice, {
          op: "updateMany",
          collection: "todos",
          filter: { internalNotes: { $exists: true } },
          update: { $set: { done: true } },
          bulk: true,
        }),
      )
      expect(filter.code).toBe(ErrorCode.InvalidQuery)
    })

    it("refuses $text in filters and preconditions of a caller that cannot read every field", async () => {
      await coll("todos").insertOne({ _id: 41, ownerId: "alice", internalNotes: "secret plan" })
      await coll("todos").createIndex({ internalNotes: "text" })
      try {
        const search = { $text: { $search: "secret" } }
        const where = await failure(
          run(alice, {
            op: "update",
            collection: "todos",
            id: 41,
            update: { $set: { done: true } },
            where: search,
          }),
        )
        expect(where.code).toBe(ErrorCode.InvalidQuery)
        expect(where.message).toMatch(/\$text/)
        const filter = await failure(
          run(alice, {
            op: "updateMany",
            collection: "todos",
            filter: search,
            update: { $set: { done: true } },
            bulk: true,
          }),
        )
        expect(filter.code).toBe(ErrorCode.InvalidQuery)
        expect((await byId("todos", 41))?.["done"]).toBeUndefined()
        const allowed = await run(service, {
          op: "updateMany",
          collection: "todos",
          filter: search,
          update: { $set: { done: true } },
          bulk: true,
        })
        expect(allowed.matched).toBe(1)
      } finally {
        await coll("todos").dropIndex("internalNotes_text")
      }
    })

    it("decodes EJSON values in ids", async () => {
      const hex = "6728f0c2a1b2c3d4e5f60718"
      await coll("todos").insertOne({ _id: new BSON.ObjectId(hex), ownerId: "alice" })
      const result = await run(alice, {
        op: "update",
        collection: "todos",
        id: new WireObjectId(hex),
        update: { $set: { done: true } },
      })
      expect(result.modified).toBe(1)
    })
  })

  describe("updateMany and deleteMany", () => {
    beforeEach(async () => {
      await coll("todos").insertMany([
        { _id: 1, ownerId: "alice", title: "a" },
        { _id: 2, ownerId: "alice", title: "a" },
        { _id: 3, ownerId: "bob", title: "a" },
        { _id: 4, ownerId: "alice", title: "z", archived: true },
      ])
    })

    it("updates only visible documents", async () => {
      const result = await run(alice, {
        op: "updateMany",
        collection: "todos",
        filter: { title: "a" },
        update: { $set: { done: true } },
        bulk: true,
      })
      expect(result).toMatchObject({ matched: 2, modified: 2 })
      expect(result.documents).toBeUndefined()
      expect(
        (await docs("todos")).filter((doc) => doc["done"] === true).map((d) => d["_id"]),
      ).toEqual([1, 2])
    })

    it("requires the bulk opt in", async () => {
      const error = await failure(
        run(alice, {
          op: "updateMany",
          collection: "todos",
          filter: {},
          update: { $set: { done: true } },
        } as unknown as WriteRequest),
      )
      expect(error.code).toBe(ErrorCode.InvalidQuery)
    })

    it("enforces maxBulk before writing anything", async () => {
      await coll("todos").insertOne({ _id: 5, ownerId: "alice", title: "a" })
      const error = await failure(
        run(alice, {
          op: "updateMany",
          collection: "todos",
          filter: {},
          update: { $set: { done: true } },
          bulk: true,
        }),
      )
      expect(error.code).toBe(ErrorCode.BulkLimit)
      expect(await coll("todos").countDocuments({ done: true })).toBe(0)
    })

    it("deletes only visible documents and honours restrictive policies", async () => {
      const result = await run(alice, {
        op: "deleteMany",
        collection: "todos",
        filter: {},
        bulk: true,
      })
      expect(result).toMatchObject({ matched: 2, deleted: 2 })
      expect((await docs("todos")).map((doc) => doc["_id"])).toEqual([3, 4])
    })

    it("rolls back a whole updateMany when one result fails the check", async () => {
      const error = await failure(
        run(alice, {
          op: "updateMany",
          collection: "todos",
          filter: { title: "a" },
          update: { $set: { ownerId: "mallory" } },
          bulk: true,
        }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect(await coll("todos").countDocuments({ ownerId: "mallory" })).toBe(0)
    })
  })

  describe("delete", () => {
    beforeEach(async () => {
      await coll("todos").insertMany([
        { _id: 1, ownerId: "alice", title: "a", internalNotes: "n" },
        { _id: 2, ownerId: "bob", title: "b" },
        { _id: 3, ownerId: "alice", archived: true },
      ])
    })

    it("deletes a visible document and returns its readable pre image", async () => {
      const result = await run(alice, { op: "delete", collection: "todos", id: 1 })
      expect(relaxed(result)).toMatchObject({ deleted: 1, changedIds: [1] })
      expect(relaxed(result.documents)).toEqual([{ _id: 1, ownerId: "alice", title: "a" }])
    })

    it("cannot delete what it cannot see or what a restrictive policy protects", async () => {
      expect((await run(alice, { op: "delete", collection: "todos", id: 2 })).deleted).toBe(0)
      expect((await run(alice, { op: "delete", collection: "todos", id: 3 })).deleted).toBe(0)
      expect(await docs("todos")).toHaveLength(3)
    })

    it("is forbidden without a delete grant", async () => {
      await coll("plain").insertOne({ _id: 1, ownerId: "alice" })
      const error = await failure(run(alice, { op: "delete", collection: "plain", id: 1 }))
      expect(error.code).toBe(ErrorCode.Forbidden)
    })
  })

  describe("replace", () => {
    it("replaces a visible document when the field rules allow whole documents", async () => {
      await coll("plain").insertOne({ _id: 1, ownerId: "alice", a: 1 })
      const result = await run(alice, {
        op: "replace",
        collection: "plain",
        id: 1,
        doc: { ownerId: "alice", b: 2 },
      })
      expect(relaxed(result.documents)).toEqual([{ _id: 1, ownerId: "alice", b: 2 }])
    })

    it("refuses replacements on collections with field rules or immutable fields", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice" })
      const error = await failure(
        run(alice, { op: "replace", collection: "todos", id: 1, doc: { ownerId: "alice" } }),
      )
      expect(error.code).toBe(ErrorCode.Forbidden)
    })

    it("upserts through the insert check and refuses a mismatched _id", async () => {
      const result = await run(alice, {
        op: "replace",
        collection: "plain",
        id: 7,
        doc: { ownerId: "alice" },
        upsert: true,
      })
      expect(relaxed(result)).toMatchObject({ upsertedId: 7, insertedIds: [7] })
      const bad = await failure(
        run(alice, {
          op: "replace",
          collection: "plain",
          id: 8,
          doc: { ownerId: "bob" },
          upsert: true,
        }),
      )
      expect(bad.code).toBe(ErrorCode.PolicyViolation)
      const mismatch = await failure(
        run(alice, {
          op: "replace",
          collection: "plain",
          id: 7,
          doc: { _id: 9, ownerId: "alice" },
        }),
      )
      expect(mismatch.code).toBe(ErrorCode.InvalidQuery)
    })

    it("never overwrites an invisible document through upsert", async () => {
      await coll("plain").insertOne({ _id: 1, ownerId: "bob", secret: true })
      const error = await failure(
        run(alice, {
          op: "replace",
          collection: "plain",
          id: 1,
          doc: { ownerId: "alice" },
          upsert: true,
        }),
      )
      expect(error.code).toBe(ErrorCode.DuplicateKey)
      expect(await docs("plain")).toEqual([{ _id: 1, ownerId: "bob", secret: true }])
    })
  })

  describe("idempotency", () => {
    it("replays a repeated mutation ID without applying it twice", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice", count: 0 })
      const request: WriteRequest = {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $inc: { count: 1 } },
      }
      const first = await run(alice, request, "mutation-0001")
      const second = await run(alice, request, "mutation-0001")
      expect(first.replayed).toBe(false)
      expect(second.replayed).toBe(true)
      expect(second).toMatchObject({ matched: 1, modified: 1 })
      expect(relaxed(second.documents)).toEqual(relaxed(first.documents))
      expect(BigInt(second.ct) >= BigInt(first.ct)).toBe(true)
      expect((await docs("todos"))[0]?.["count"]).toBe(1)
    })

    it("replays a retry whose second attempt would fail, instead of returning that failure", async () => {
      const insert: WriteRequest = {
        op: "insert",
        collection: "todos",
        doc: { _id: 1, ownerId: "alice" },
      }
      await run(alice, insert, "mutation-retry1")
      const again = await run(alice, insert, "mutation-retry1")
      expect(again.replayed).toBe(true)
      expect(relaxed(again.insertedIds)).toEqual([1])

      await coll("boards").insertOne({ _id: 1, ownerId: "alice", count: 2 })
      const bump: WriteRequest = {
        op: "update",
        collection: "boards",
        id: 1,
        update: { $inc: { count: 1 } },
      }
      await run(alice, bump, "mutation-retry2")
      const unkeyed = await failure(run(alice, bump))
      expect(unkeyed.code).toBe(ErrorCode.PolicyViolation)
      const replayed = await run(alice, bump, "mutation-retry2")
      expect(replayed.replayed).toBe(true)
      expect(relaxed(replayed)).toMatchObject({ matched: 1, modified: 1 })
      expect((await byId("boards", 1))?.["count"]).toBe(3)
    })

    it("applies concurrent duplicates exactly once", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice", count: 0 })
      const request: WriteRequest = {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $inc: { count: 1 } },
      }
      const results = await Promise.all(
        Array.from({ length: 6 }, () => run(alice, request, "mutation-0002")),
      )
      expect(results.filter((result) => !result.replayed)).toHaveLength(1)
      expect((await docs("todos"))[0]?.["count"]).toBe(1)
    })

    it("rejects a mutation ID reused by another subject or for another write", async () => {
      await run(
        alice,
        { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } },
        "m-00000003",
      )
      const other = await failure(
        run(
          bob,
          { op: "insert", collection: "todos", doc: { _id: 2, ownerId: "bob" } },
          "m-00000003",
        ),
      )
      expect(other.code).toBe(ErrorCode.Conflict)
      const different = await failure(
        run(alice, { op: "delete", collection: "todos", id: 1 }, "m-00000003"),
      )
      expect(different.code).toBe(ErrorCode.Conflict)
      expect(await docs("todos")).toHaveLength(1)
    })

    it("rejects a mutation ID reused for a different request or role set", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice", count: 0 })
      const bump = (by: number): WriteRequest => ({
        op: "update",
        collection: "todos",
        id: 1,
        update: { $inc: { count: by } },
      })
      await run(alice, bump(1), "m-fingerprint")
      const body = await failure(run(alice, bump(5), "m-fingerprint"))
      expect(body.code).toBe(ErrorCode.Conflict)
      expect(body.message).toMatch(/different write/)
      const roles: Caller = {
        context: { ...alice.context, roles: new Set(["authenticated", "editor"]) },
        subject: "alice",
      }
      const elevated = await failure(run(roles, bump(1), "m-fingerprint"))
      expect(elevated.code).toBe(ErrorCode.Conflict)
      expect((await run(alice, bump(1), "m-fingerprint")).replayed).toBe(true)
      expect((await byId("todos", 1))?.["count"]).toBe(1)

      const batch = (title: string): WriteRequest[] => [
        { op: "update", collection: "todos", id: 1, update: { $set: { title } } },
      ]
      await writes.executeBatch(alice, batch("a"), { mutationId: "m-fingerprint-batch" })
      const otherBatch = await failure(
        writes.executeBatch(alice, batch("b"), { mutationId: "m-fingerprint-batch" }),
      )
      expect(otherBatch.code).toBe(ErrorCode.Conflict)
      expect((await byId("todos", 1))?.["title"]).toBe("a")
    })

    it("still replays records written before mutation IDs were bound to their request", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice", count: 0 })
      const bump = (by: number): WriteRequest => ({
        op: "update",
        collection: "todos",
        id: 1,
        update: { $inc: { count: by } },
      })
      await run(alice, bump(1), "m-legacy-record")
      await client
        .db(metaName)
        .collection<{ _id: string }>("mutations")
        .updateOne({ _id: "m-legacy-record" }, { $unset: { fp: "" } })
      const replayed = await run(alice, bump(5), "m-legacy-record")
      expect(replayed.replayed).toBe(true)
      expect((await byId("todos", 1))?.["count"]).toBe(1)
    })

    it("records nothing when the write fails, so a corrected retry with the same ID applies", async () => {
      await failure(
        run(
          alice,
          { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "bob" } },
          "m-00000004",
        ),
      )
      expect(await client.db(metaName).collection("mutations").countDocuments()).toBe(0)
      const retry = await run(
        alice,
        { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } },
        "m-00000004",
      )
      expect(retry.replayed).toBe(false)
    })

    it("stores records in the meta database with a TTL index and validates IDs", async () => {
      await run(
        alice,
        { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } },
        "m-00000005",
      )
      const meta = client.db(metaName).collection("mutations")
      expect(await meta.findOne({ _id: "m-00000005" as never })).toMatchObject({
        sub: "alice",
        c: "todos",
        op: "insert",
      })
      const indexes = await meta.indexes()
      expect(indexes.find((index) => index.name === "ttl_at")).toMatchObject({
        key: { at: 1 },
        expireAfterSeconds: 86_400,
      })
      const bad = await failure(
        run(alice, { op: "insert", collection: "todos", doc: { ownerId: "alice" } }, "bad id!"),
      )
      expect(bad.code).toBe(ErrorCode.InvalidQuery)
    })
  })

  describe("fast path", () => {
    const WRITES = new Set(["insert", "update", "delete", "findAndModify"])

    async function commands<T>(
      body: () => Promise<T>,
    ): Promise<{ value: T; writes: string[]; transactional: boolean }> {
      const seen: { name: string; txn: boolean }[] = []
      const listener = (event: { commandName: string; command: Document }): void => {
        seen.push({
          name: event.commandName,
          txn:
            event.command["startTransaction"] === true || event.commandName === "commitTransaction",
        })
      }
      client.on("commandStarted", listener)
      try {
        const value = await body()
        return {
          value,
          writes: seen.filter((c) => WRITES.has(c.name)).map((c) => c.name),
          transactional: seen.some((c) => c.txn),
        }
      } finally {
        client.off("commandStarted", listener)
      }
    }

    beforeEach(async () => {
      await coll("notes").insertMany([
        { _id: 1, body: "a", secret: "s", team: "t1" },
        { _id: 2, body: "b", team: "t2" },
      ])
    })

    it("runs a check free single update as one atomic command without a transaction", async () => {
      const { value, writes, transactional } = await commands(() =>
        run(editor, { op: "update", collection: "notes", id: 1, update: { $set: { body: "x" } } }),
      )
      expect(transactional).toBe(false)
      expect(writes).toEqual(["update"])
      expect(relaxed(value)).toMatchObject({ matched: 1, modified: 1, changedIds: [1] })
      expect(relaxed(value.documents)).toEqual([{ _id: 1, body: "x", team: "t1" }])
      expect(isClusterTime(value.ct)).toBe(true)
    })

    it("skips the transaction when the update cannot change what its check reads", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice", title: "t" })
      const { value, writes, transactional } = await commands(() =>
        run(alice, { op: "update", collection: "todos", id: 1, update: { $set: { done: true } } }),
      )
      expect(transactional).toBe(false)
      expect(writes).toEqual(["update"])
      expect(relaxed(value)).toMatchObject({ matched: 1, modified: 1, changedIds: [1] })
      expect(relaxed(value.documents)).toEqual([
        { _id: 1, ownerId: "alice", title: "t", done: true },
      ])
      const invisible = await commands(() =>
        run(bob, { op: "update", collection: "todos", id: 1, update: { $set: { done: false } } }),
      )
      expect(invisible.transactional).toBe(false)
      expect(relaxed(invisible.value)).toMatchObject({ matched: 0, modified: 0 })
      expect((await byId("todos", 1))?.["done"]).toBe(true)
    })

    it("keeps the transaction when the update writes a checked field or the check asks for more", async () => {
      await coll("todos").insertOne({ _id: 1, ownerId: "alice" })
      const handover = await commands(() =>
        failure(
          run(alice, {
            op: "update",
            collection: "todos",
            id: 1,
            update: { $set: { ownerId: "bob" } },
          }),
        ),
      )
      expect(handover.transactional).toBe(true)
      expect(handover.value.code).toBe(ErrorCode.PolicyViolation)
      expect((await byId("todos", 1))?.["ownerId"]).toBe("alice")

      await coll("boards").insertOne({ _id: 1, ownerId: "alice", count: 3, title: "b" })
      const stricter = await commands(() =>
        run(alice, { op: "update", collection: "boards", id: 1, update: { $set: { title: "c" } } }),
      )
      expect(stricter.transactional).toBe(true)
    })

    it("keeps the transaction when a mutation ID is given", async () => {
      const keyed = await commands(() =>
        run(
          editor,
          { op: "update", collection: "notes", id: 1, update: { $inc: { n: 1 } } },
          "m-fast-0001",
        ),
      )
      expect(keyed.transactional).toBe(true)
      const replay = await run(
        editor,
        { op: "update", collection: "notes", id: 1, update: { $inc: { n: 1 } } },
        "m-fast-0001",
      )
      expect(replay.replayed).toBe(true)
      expect((await byId("notes", 1))?.["n"]).toBe(1)
    })

    it("checks a single insert in MongoDB before writing it, without a transaction", async () => {
      const seen: string[] = []
      const listener = (event: { commandName: string }): void => {
        seen.push(event.commandName)
      }
      const inserted = await commands(() =>
        run(alice, {
          op: "insert",
          collection: "todos",
          doc: { title: "t", done: false, ownerId: "alice", _id: 7 },
        }),
      )
      expect(inserted.transactional).toBe(false)
      expect(inserted.writes).toEqual(["insert"])
      expect(relaxed(inserted.value.documents)).toEqual([
        { _id: 7, title: "t", done: false, ownerId: "alice" },
      ])
      expect(Object.keys((await byId("todos", 7)) ?? {})).toEqual([
        "_id",
        "title",
        "done",
        "ownerId",
      ])

      client.on("commandStarted", listener)
      try {
        const error = await failure(
          run(alice, { op: "insert", collection: "todos", doc: { _id: 8, ownerId: "bob" } }),
        )
        expect(error.code).toBe(ErrorCode.PolicyViolation)
      } finally {
        client.off("commandStarted", listener)
      }
      expect(seen).not.toContain("insert")
      expect(await byId("todos", 8)).toBeNull()
    })

    it("keeps the transaction for several documents and refuses all of them when one fails", async () => {
      const many = await commands(() =>
        run(alice, {
          op: "insertMany",
          collection: "todos",
          docs: [
            { _id: 1, ownerId: "alice" },
            { _id: 2, ownerId: "alice" },
          ],
        }),
      )
      expect(many.transactional).toBe(true)
      expect(relaxed(many.value.documents)).toEqual([
        { _id: 1, ownerId: "alice" },
        { _id: 2, ownerId: "alice" },
      ])
      const error = await failure(
        run(alice, {
          op: "insertMany",
          collection: "todos",
          docs: [
            { _id: 3, ownerId: "alice" },
            { _id: 4, ownerId: "bob" },
          ],
        }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect((await docs("todos")).map((doc) => doc["_id"])).toEqual([1, 2])
    })

    it("checks documents too large to send twice after writing them, in a transaction", async () => {
      const big = "x".repeat(9 * 1024 * 1024)
      const accepted = await commands(() =>
        run(alice, { op: "insert", collection: "plain", doc: { _id: 1, ownerId: "alice", big } }),
      )
      expect(accepted.transactional).toBe(true)
      const error = await failure(
        run(alice, { op: "insert", collection: "plain", doc: { _id: 2, ownerId: "bob", big } }),
      )
      expect(error.code).toBe(ErrorCode.PolicyViolation)
      expect(await byId("plain", 2)).toBeNull()
    })

    it("inserts, replaces with upsert and deletes on the fast path", async () => {
      const inserted = await commands(() =>
        run(editor, { op: "insert", collection: "notes", doc: { _id: 3, body: "$5", secret: 1 } }),
      )
      expect(inserted.transactional).toBe(false)
      expect(relaxed(inserted.value.documents)).toEqual([{ _id: 3, body: "$5" }])

      const upserted = await commands(() =>
        run(editor, {
          op: "replace",
          collection: "notes",
          id: 4,
          doc: { body: "d" },
          upsert: true,
        }),
      )
      expect(upserted.transactional).toBe(false)
      expect(relaxed(upserted.value)).toMatchObject({ upsertedId: 4, insertedIds: [4] })

      const replaced = await run(editor, {
        op: "replace",
        collection: "notes",
        id: 4,
        doc: { body: "e" },
      })
      expect(relaxed(replaced)).toMatchObject({ matched: 1, modified: 1, changedIds: [4] })

      const deleted = await commands(() =>
        run(editor, { op: "delete", collection: "notes", id: 1 }),
      )
      expect(deleted.transactional).toBe(false)
      expect(deleted.writes).toEqual(["findAndModify"])
      expect(relaxed(deleted.value)).toMatchObject({ deleted: 1, changedIds: [1] })
      expect(relaxed(deleted.value.documents)).toEqual([{ _id: 1, body: "a", team: "t1" }])
      expect((await docs("notes")).map((doc) => doc["_id"])).toEqual([2, 3, 4])
    })

    it("reports where conflicts and invisible targets like the transactional path", async () => {
      const conflict = await failure(
        run(editor, {
          op: "update",
          collection: "notes",
          id: 1,
          update: { $set: { body: "x" } },
          where: { body: "other" },
        }),
      )
      expect(conflict.code).toBe(ErrorCode.Conflict)
      const missing = await run(editor, {
        op: "delete",
        collection: "notes",
        id: 99,
        where: { body: "a" },
      })
      expect(missing).toMatchObject({ matched: 0, deleted: 0 })
      const lead: Caller = {
        context: {
          roles: new Set(["authenticated", "teamlead"]),
          claims: { sub: "l", team: "t2" },
          now: new Date(),
        },
        subject: "l",
      }
      const hiddenTarget = await run(lead, {
        op: "update",
        collection: "notes",
        id: 1,
        update: { $set: { body: "x" } },
      })
      expect(hiddenTarget).toMatchObject({ matched: 0, modified: 0 })
      expect((await byId("notes", 1))?.["body"]).toBe("a")
    })

    it("treats a policy that resolves to deny as matching nothing on both paths", async () => {
      const noTeam: Caller = {
        context: {
          roles: new Set(["authenticated", "teamlead"]),
          claims: { sub: "l" },
          now: new Date(),
        },
        subject: "l",
      }
      const fast = await run(noTeam, {
        op: "update",
        collection: "notes",
        id: 2,
        update: { $set: { body: "x" } },
      })
      expect(fast).toMatchObject({ matched: 0, modified: 0 })
      expect(isClusterTime(fast.ct)).toBe(true)
      const keyed = await run(
        noTeam,
        { op: "update", collection: "notes", id: 2, update: { $set: { body: "x" } } },
        "m-deny-0001",
      )
      expect(keyed).toMatchObject({ matched: 0, modified: 0 })
      const noSub: Caller = {
        context: { roles: new Set(["authenticated"]), claims: {}, now: new Date() },
        subject: "nosub",
      }
      await coll("todos").insertOne({ _id: 1, ownerId: "alice" })
      const txn = await run(noSub, {
        op: "update",
        collection: "todos",
        id: 1,
        update: { $set: { done: true } },
      })
      expect(txn).toMatchObject({ matched: 0, modified: 0 })
      expect(isClusterTime(txn.ct)).toBe(true)
      expect((await byId("notes", 2))?.["body"]).toBe("b")
    })
  })

  describe("commands and read back", () => {
    const TRACED = new Set(["update", "delete", "insert", "find", "aggregate", "findAndModify"])

    async function traced<T>(body: () => Promise<T>): Promise<{ value: T; names: string[] }> {
      const names: string[] = []
      const listener = (event: { commandName: string }): void => {
        if (
          TRACED.has(event.commandName) ||
          event.commandName === "bulkWrite" ||
          event.commandName === "commitTransaction"
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

    let bulkWrite = false
    beforeAll(async () => {
      const hello = await client.db("admin").command({ hello: 1 })
      bulkWrite = Number(hello["maxWireVersion"]) >= 25
    })

    beforeEach(async () => {
      await coll("slots").insertMany([
        { _id: 1, public: true, secret: "s1", n: 0 },
        { _id: 2, public: false, secret: "s2", n: 0 },
        { _id: 3, public: true, n: 0 },
      ])
    })

    it("returns every fast path update's own post image under concurrency", async () => {
      await coll("notes").insertMany(
        Array.from({ length: 200 }, (_, i) => ({ _id: 100 + i, team: "t", n: 0 })),
      )
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          run(editor, {
            op: "update",
            collection: "notes",
            id: 100 + i,
            update: { $inc: { n: 1 }, $set: { mark: i } },
          }),
        ),
      )
      for (const [i, result] of results.entries()) {
        expect(result.replayed).toBe(false)
        expect(relaxed(result.documents)).toEqual([{ _id: 100 + i, team: "t", n: 1, mark: i }])
      }
    })

    it("reads one document back with find, applying read rules and field rules", async () => {
      const visible = await traced(() =>
        run(writer, { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } }),
      )
      expect(visible.names).toEqual(["update", "find"])
      expect(relaxed(visible.value.documents)).toEqual([{ _id: 1, public: true, n: 1 }])
      const hidden = await run(writer, {
        op: "update",
        collection: "slots",
        id: 1,
        update: { $set: { public: false } },
      })
      expect(hidden).toMatchObject({ matched: 1, modified: 1 })
      expect(hidden.documents).toEqual([null])
      expect((await byId("slots", 1))?.["public"]).toBe(false)
      const invisible = await run(writer, {
        op: "update",
        collection: "slots",
        id: 2,
        update: { $inc: { n: 1 } },
      })
      expect(invisible).toMatchObject({ matched: 0, modified: 0 })
      expect((await byId("slots", 2))?.["n"]).toBe(0)
    })

    it("evaluates a check and reads back in one aggregation, with the same results", async () => {
      const visible = await traced(() =>
        run(checker, { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } }),
      )
      expect(visible.names).toContain("aggregate")
      expect(visible.names).not.toContain("find")
      expect(relaxed(visible.value.documents)).toEqual([{ _id: 1, public: true, n: 1 }])
      const refused = await failure(
        run(checker, { op: "update", collection: "slots", id: 1, update: { $set: { n: 100 } } }),
      )
      expect(refused.code).toBe(ErrorCode.PolicyViolation)
      expect((await byId("slots", 1))?.["n"]).toBe(1)
      const hidden = await run(checker, {
        op: "update",
        collection: "slots",
        id: 1,
        update: { $set: { public: false } },
      })
      expect(hidden).toMatchObject({ matched: 1, modified: 1 })
      expect(hidden.documents).toEqual([null])
    })

    it("skips the read back when documents are not wanted, but still evaluates check", async () => {
      const update = await traced(() =>
        writes.execute(
          writer,
          { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } },
          { returnDocuments: false },
        ),
      )
      expect(update.names).toEqual(["update"])
      expect(update.value.documents).toBeUndefined()
      expect(relaxed(update.value)).toMatchObject({ matched: 1, modified: 1, changedIds: [1] })

      const remove = await traced(() =>
        writes.execute(
          writer,
          { op: "delete", collection: "slots", id: 3 },
          { returnDocuments: false },
        ),
      )
      expect(remove.names).toEqual(["delete"])
      expect(relaxed(remove.value)).toMatchObject({ deleted: 1, changedIds: [3] })
      expect(await byId("slots", 3)).toBeNull()

      const refused = await failure(
        writes.execute(
          checker,
          { op: "update", collection: "slots", id: 1, update: { $set: { n: 500 } } },
          { returnDocuments: false },
        ),
      )
      expect(refused.code).toBe(ErrorCode.PolicyViolation)
      expect((await byId("slots", 1))?.["n"]).toBe(1)

      const insert = await traced(() =>
        writes.execute(
          alice,
          { op: "insert", collection: "todos", doc: { _id: 9, ownerId: "alice" } },
          { returnDocuments: false },
        ),
      )
      expect(insert.value.documents).toBeUndefined()
      expect(insert.names).not.toContain("find")
      const wrongOwner = await failure(
        writes.execute(
          alice,
          { op: "insert", collection: "todos", doc: { _id: 10, ownerId: "bob" } },
          { returnDocuments: false },
        ),
      )
      expect(wrongOwner.code).toBe(ErrorCode.PolicyViolation)
      expect(await byId("todos", 10)).toBeNull()
    })

    it("sends a keyed update and its record as one command on MongoDB 8.0 and later", async () => {
      const keyed = await traced(() =>
        writes.execute(
          writer,
          { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } },
          { mutationId: "m-bulk-0001", returnDocuments: false },
        ),
      )
      expect(keyed.names).toEqual(
        bulkWrite ? ["bulkWrite", "commitTransaction"] : ["update", "insert", "commitTransaction"],
      )
      const withDocs = await traced(() =>
        writes.execute(
          writer,
          { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } },
          { mutationId: "m-bulk-0002" },
        ),
      )
      expect(withDocs.names).toEqual(
        bulkWrite
          ? ["bulkWrite", "find", "commitTransaction"]
          : ["update", "find", "insert", "commitTransaction"],
      )
      const replay = await writes.execute(
        writer,
        { op: "update", collection: "slots", id: 1, update: { $inc: { n: 1 } } },
        { mutationId: "m-bulk-0001" },
      )
      expect(replay.replayed).toBe(true)
      expect(relaxed(replay)).toMatchObject({ matched: 1, modified: 1, changedIds: [1] })
      expect(relaxed(replay.documents)).toEqual([{ _id: 1, public: true, n: 2 }])
      expect((await byId("slots", 1))?.["n"]).toBe(2)
    })

    it("stores the real outcome of a keyed write that matched nothing or changed nothing", async () => {
      const missing: WriteRequest = {
        op: "update",
        collection: "slots",
        id: 404,
        update: { $set: { n: 1 } },
      }
      const first = await run(writer, missing, "m-outcome-01")
      expect(first).toMatchObject({ matched: 0, modified: 0, changedIds: [] })
      const again = await run(writer, missing, "m-outcome-01")
      expect(again).toMatchObject({ replayed: true, matched: 0, modified: 0, changedIds: [] })

      const same: WriteRequest = {
        op: "update",
        collection: "slots",
        id: 1,
        update: { $set: { n: 0 } },
      }
      const unchanged = await run(writer, same, "m-outcome-02")
      expect(unchanged).toMatchObject({ matched: 1, modified: 0, changedIds: [] })
      const replayed = await run(writer, same, "m-outcome-02")
      expect(replayed).toMatchObject({ replayed: true, matched: 1, modified: 0, changedIds: [] })
      const stored = await client
        .db(metaName)
        .collection("mutations")
        .findOne({ _id: "m-outcome-02" as never })
      expect(relaxed(stored?.["result"])).toEqual({
        matched: 1,
        modified: 0,
        deleted: 0,
        insertedIds: [],
        changedIds: [],
      })
    })

    it("keeps no documents in idempotency records and reads them again on replay", async () => {
      const insert: WriteRequest = {
        op: "insert",
        collection: "todos",
        doc: { _id: 5, ownerId: "alice", title: "a" },
      }
      const first = await run(alice, insert, "m-record-01")
      expect(relaxed(first.documents)).toEqual([{ _id: 5, ownerId: "alice", title: "a" }])
      const stored = await client
        .db(metaName)
        .collection("mutations")
        .findOne({ _id: "m-record-01" as never })
      expect(stored?.["result"]).toBeDefined()
      expect(stored?.["result"]).not.toHaveProperty("documents")
      await db
        .collection("todos")
        .updateOne({ _id: 5 } as Document, { $set: { title: "b", internalNotes: "n" } })
      const replay = await run(alice, insert, "m-record-01")
      expect(replay.replayed).toBe(true)
      expect(relaxed(replay.documents)).toEqual([{ _id: 5, ownerId: "alice", title: "b" }])

      const remove: WriteRequest = { op: "delete", collection: "todos", id: 5 }
      const deleted = await run(alice, remove, "m-record-02")
      expect(relaxed(deleted.documents)).toEqual([{ _id: 5, ownerId: "alice", title: "b" }])
      const replayedDelete = await run(alice, remove, "m-record-02")
      expect(replayedDelete).toMatchObject({ replayed: true, deleted: 1, documents: [null] })
    })

    it("checks every document of an insertMany that returns no documents", async () => {
      const ok = await traced(() =>
        writes.execute(
          alice,
          {
            op: "insertMany",
            collection: "todos",
            docs: [
              { _id: 20, ownerId: "alice" },
              { _id: 21, ownerId: "alice" },
            ],
          },
          { returnDocuments: false },
        ),
      )
      expect(ok.value.documents).toBeUndefined()
      expect(relaxed(ok.value.insertedIds)).toEqual([20, 21])
      expect(ok.names).not.toContain("find")
      const refused = await failure(
        writes.execute(
          alice,
          {
            op: "insertMany",
            collection: "todos",
            docs: [
              { _id: 22, ownerId: "alice" },
              { _id: 23, ownerId: "bob" },
            ],
          },
          { returnDocuments: false },
        ),
      )
      expect(refused.code).toBe(ErrorCode.PolicyViolation)
      expect(await byId("todos", 22)).toBeNull()
    })

    it("refuses a duplicate key in a keyed insert and records nothing", async () => {
      await coll("todos").insertOne({ _id: 6, ownerId: "alice" })
      const duplicate = await failure(
        run(
          alice,
          { op: "insert", collection: "todos", doc: { _id: 6, ownerId: "alice" } },
          "m-dup-000001",
        ),
      )
      expect(duplicate.code).toBe(ErrorCode.DuplicateKey)
      const records = client.db(metaName).collection("mutations")
      expect(await records.countDocuments({ _id: "m-dup-000001" as never })).toBe(0)
    })
  })

  describe("MongoDB validators", () => {
    it("maps validator failures and only shows the reason to service", async () => {
      await db.command({
        collMod: "plain",
        validator: { $jsonSchema: { required: ["ownerId", "name"] } },
      })
      try {
        const error = await failure(
          run(alice, { op: "insert", collection: "plain", doc: { ownerId: "alice" } }),
        )
        expect(error.code).toBe(ErrorCode.ValidationFailed)
        expect(error.details).toBeUndefined()
        const svc = await failure(
          run(service, { op: "insert", collection: "plain", doc: { ownerId: "alice" } }),
        )
        expect(svc.code).toBe(ErrorCode.ValidationFailed)
        expect(svc.details?.["reason"]).toBeDefined()
      } finally {
        await db.command({ collMod: "plain", validator: {} })
      }
    })
  })

  it("writes nothing but the caller documents into the app database", async () => {
    const before = (await db.listCollections().toArray()).map((c) => c.name).sort()
    await run(
      alice,
      { op: "insert", collection: "todos", doc: { _id: 1, ownerId: "alice" } },
      "m-00000006",
    )
    const after = (await db.listCollections().toArray()).map((c) => c.name).sort()
    expect(after).toEqual(before)
    expect(await coll("todos").indexes()).toHaveLength(1)
  })
})
