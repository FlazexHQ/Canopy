import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Caller, WritePath, type WriteRequest } from "../src/index.ts"

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub") })
      .named("create own"),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .named("edit own"),
    restrict
      .insert("authenticated")
      .check({ archived: { $ne: true } })
      .named("no archived inserts"),
  ],
  fields: { write: { default: { only: ["title", "ownerId", "archived", "createdAt"] } } },
  immutable: ["createdAt"],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

const alice: Caller = {
  context: { roles: new Set(["authenticated"]), claims: { sub: "alice" }, now: new Date() },
  subject: "alice",
}

suite("explained denials", () => {
  const dbName = `canopy_rest_explain_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let explaining: WritePath
  let quiet: WritePath

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    const shared = {
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: testPolicyEngine(createPolicySet([todos])),
    }
    explaining = new WritePath({ ...shared, explainDenials: true })
    quiet = new WritePath(shared)
    await db.createCollection("todos")
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    await db.collection("todos").deleteMany({})
    await db
      .collection("todos")
      .insertOne({ _id: "t1" as never, ownerId: "alice", createdAt: 1, title: "a" })
  })

  const refusal = async (writes: WritePath, request: WriteRequest): Promise<CanopyError> => {
    const error = await writes.execute(alice, request).catch((e: unknown) => e)
    if (!(error instanceof CanopyError)) throw new Error(`expected a refusal, got ${String(error)}`)
    return error
  }

  it("names the check policies and their resolved filters when an insert fails a check", async () => {
    const error = await refusal(explaining, {
      op: "insert",
      collection: "todos",
      doc: { _id: "x", ownerId: "bob" },
    })
    expect(error.code).toBe(ErrorCode.PolicyViolation)
    expect(error.details?.["explain"]).toMatchObject({
      collection: "todos",
      op: "insert",
      clause: "check",
      roles: ["authenticated"],
      policies: expect.arrayContaining([
        expect.objectContaining({
          name: "create own",
          kind: "permissive",
          applies: true,
          filter: { ownerId: "alice" },
        }),
        expect.objectContaining({
          name: "no archived inserts",
          kind: "restrictive",
          applies: true,
        }),
      ]),
    })
  })

  it("lists the using policies when no policy grants the operation", async () => {
    const error = await refusal(explaining, { op: "delete", collection: "todos", id: "t1" })
    expect(error.code).toBe(ErrorCode.Forbidden)
    const explain = error.details?.["explain"] as {
      clause: string
      op: string
      policies: { name: string; applies: boolean; reason: string }[]
    }
    expect(explain.clause).toBe("using")
    expect(explain.op).toBe("delete")
    expect(explain.policies.map((policy) => policy.name)).toContain("edit own")
    expect(explain.policies.filter((policy) => policy.applies)).toEqual([])
    expect(explain.policies.every((policy) => policy.reason.length > 0)).toBe(true)
  })

  it("names the fields a field rule or immutability refused", async () => {
    const fields = await refusal(explaining, {
      op: "update",
      collection: "todos",
      id: "t1",
      update: { $set: { secret: 1 } },
    })
    expect(fields.details?.["explain"]).toEqual({ rule: "fields.write", fields: ["secret"] })
    const frozen = await refusal(explaining, {
      op: "update",
      collection: "todos",
      id: "t1",
      update: { $set: { createdAt: 2 } },
    })
    expect(frozen.details?.["explain"]).toEqual({ rule: "immutable", fields: ["createdAt"] })
  })

  it("explains nothing unless asked to", async () => {
    const error = await refusal(quiet, {
      op: "insert",
      collection: "todos",
      doc: { _id: "x", ownerId: "bob" },
    })
    expect(error.code).toBe(ErrorCode.PolicyViolation)
    expect(error.details).toBeUndefined()
  })
})
