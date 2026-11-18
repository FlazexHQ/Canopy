import { compileFilter } from "@canopy/matcher"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { CanopyError } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import fc from "fast-check"
import { type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Caller, WritePath, type WriteRequest } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

const boards = collection("boards", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), count: { $lte: 3 } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub"), count: { $lte: 3 } }),
  ],
})

/** Its check is implied by most updates, so they take the write path's transaction free fast path. */
const pages = collection("pages", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), title: { $exists: true } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub"), title: { $exists: true } }),
  ],
})

/** What every stored document must satisfy, whoever wrote it last: the checks with `sub` in the callers. */
const invariants: Record<string, (doc: Document) => boolean> = {
  boards: compileFilter({ ownerId: { $in: ["alice", "bob"] }, count: { $lte: 3 } }).matches,
  pages: compileFilter({ ownerId: { $in: ["alice", "bob"] }, title: { $exists: true } }).matches,
}

function user(sub: string): Caller {
  return {
    context: { roles: new Set(["authenticated"]), claims: { sub }, now: new Date() },
    subject: sub,
  }
}

const callers = { alice: user("alice"), bob: user("bob") }

const runs = Number(process.env["CANOPY_DIFF_RUNS"] ?? "1")

suite("write path invariants against MongoDB", () => {
  const dbName = `canopy_rest_inv_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let client: MongoClient
  let writes: WritePath

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: metaName,
      policies: new PolicyEngine(createPolicySet([boards, pages])),
      limits: { maxBulk: 20 },
    })
    await writes.ensureIndexes()
    for (const name of ["boards", "pages"]) await client.db(dbName).createCollection(name)
  })

  afterAll(async () => {
    await client.db(dbName).dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  })

  const stored = (name: string): Promise<Document[]> =>
    client.db(dbName).collection(name).find({}).toArray()

  const clear = async (): Promise<void> => {
    for (const name of ["boards", "pages"]) await client.db(dbName).collection(name).deleteMany({})
    await client.db(metaName).collection("mutations").deleteMany({})
  }

  const field = fc.constantFrom("count", "ownerId", "title")
  const value = fc.oneof(
    fc.integer({ min: -1, max: 6 }),
    fc.constantFrom("alice", "bob", "carol", "x"),
    fc.constant(null),
  )
  const update = fc.oneof(
    fc.tuple(field, value).map(([key, v]) => ({ $set: { [key]: v } })),
    fc.tuple(field, fc.integer({ min: -2, max: 3 })).map(([key, by]) => ({ $inc: { [key]: by } })),
    field.map((key) => ({ $unset: { [key]: "" } })),
    fc.string({ maxLength: 3 }).map((text) => ({ $set: { note: text } })),
    fc.integer({ min: 0, max: 5 }).map((n) => ({ $max: { count: n } })),
  )
  const insert = fc
    .record(
      {
        _id: fc.integer({ min: 1, max: 6 }),
        ownerId: fc.constantFrom("alice", "bob", "carol"),
        count: fc.integer({ min: 0, max: 5 }),
        title: fc.constantFrom("t", "u"),
      },
      { requiredKeys: ["_id", "ownerId"] },
    )
    .map((doc) => ({ op: "insert" as const, doc }))
  const byId = fc
    .tuple(fc.integer({ min: 1, max: 4 }), update)
    .map(([id, change]) => ({ op: "update" as const, id, update: change }))
  const many = fc.tuple(fc.integer({ min: 0, max: 4 }), update).map(([min, change]) => ({
    op: "updateMany" as const,
    filter: { count: { $gte: min } },
    update: change,
    bulk: true,
  }))
  const operation = fc.record({
    caller: fc.constantFrom<"alice" | "bob">("alice", "bob"),
    coll: fc.constantFrom("boards", "pages"),
    mutationId: fc.option(fc.uuid(), { nil: undefined }),
    request: fc.oneof(
      { weight: 1, arbitrary: insert },
      { weight: 4, arbitrary: byId },
      { weight: 2, arbitrary: many },
    ),
  })

  /** Documents 1 and 2 belong to alice and 3 and 4 to bob, in both collections, written through the path. */
  const seed = async (): Promise<void> => {
    const owners = [
      [1, "alice"],
      [2, "alice"],
      [3, "bob"],
      [4, "bob"],
    ] as const
    for (const coll of ["boards", "pages"])
      for (const [id, owner] of owners)
        await writes.execute(callers[owner], {
          op: "insert",
          collection: coll,
          doc: { _id: id, ownerId: owner, count: 1, title: "t" },
        })
  }

  it("never leaves a document that fails its check, on the fast and the transactional path", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 8 }), async (sequence) => {
        await clear()
        await seed()
        for (const { caller, coll, mutationId, request } of sequence) {
          try {
            await writes.execute(
              callers[caller],
              { ...request, collection: coll } as WriteRequest,
              mutationId === undefined ? {} : { mutationId },
            )
          } catch (error: unknown) {
            if (!(error instanceof CanopyError)) throw error
          }
          for (const name of ["boards", "pages"]) {
            const failing = (await stored(name)).filter((doc) => invariants[name]?.(doc) !== true)
            expect(failing, `${name} after ${JSON.stringify(request)}`).toEqual([])
          }
        }
      }),
      { numRuns: 100 * runs },
    )
  }, 300_000)

  it("refuses a write that breaks the check and leaves the collection as it was", async () => {
    await clear()
    const insert = (count: number) =>
      writes.execute(callers.alice, {
        op: "insert",
        collection: "boards",
        doc: { _id: count, ownerId: "alice", count },
      })
    await insert(1)
    await expect(insert(9)).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    const bump = writes.execute(
      callers.alice,
      { op: "update", collection: "boards", id: 1, update: { $inc: { count: 5 } } },
      { mutationId: "inv-0000001" },
    )
    await expect(bump).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    const titleless = writes.execute(callers.bob, {
      op: "insert",
      collection: "pages",
      doc: { _id: 1, ownerId: "bob" },
    })
    await expect(titleless).rejects.toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    expect(await stored("boards")).toEqual([{ _id: 1, ownerId: "alice", count: 1 }])
    expect(await stored("pages")).toEqual([])
  })
})
