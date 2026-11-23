import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { ctToBigInt, ErrorCode } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { BSON, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"
const BASE = "http://canopy.test/rest/v1"

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: {
    read: { default: { omit: ["internalNotes"] } },
    write: { default: { only: ["title", "done", "ownerId", "tags", "meta", "count"] } },
  },
})

const notes = collection("notes", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
  ],
})

const strict = collection("strict", {
  exposed: true,
  policies: [allow.read("authenticated"), allow.insert("authenticated")],
})

type Doc = { _id: string | BSON.ObjectId; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("REST write endpoints against MongoDB", () => {
  const dbName = `canopy_rest_writes_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let tokens: Record<"alice" | "bob", string>

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.createCollection("todos")
    await db.createCollection("notes")
    await db.createCollection("strict", {
      validator: { $jsonSchema: { bsonType: "object", required: ["name"] } },
    })
    await db.collection("strict").createIndex({ name: 1 }, { unique: true })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    const sign = (sub: string): Promise<string> =>
      new SignJWT({ sub })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
    tokens = { alice: await sign("alice"), bob: await sign("bob") }
    rest = createRestHandler({
      client,
      database: dbName,
      metaDatabase: metaName,
      policies: testPolicyEngine(createPolicySet([todos, notes, strict])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
      writeLimits: { maxBulk: 5, maxBatch: 4 },
      idTypes: { notes: "string" },
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    for (const name of ["todos", "notes", "strict"]) await db.collection(name).deleteMany({})
    await client.db(metaName).collection("mutations").deleteMany({})
  })

  type As = "alice" | "bob" | "anon" | "service"

  const call = (
    path: string,
    init: { as?: As; method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const as = init.as ?? "alice"
    return rest.fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? "POST",
        headers: {
          apikey: as === "service" ? SECRET : PUBLISHABLE,
          ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  }

  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>

  const documents = (name: string): Promise<Doc[]> =>
    db.collection<Doc>(name).find({}).sort({ _id: 1 }).toArray()

  const problem = async (response: Response, status: number, code: string) => {
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toBe("application/problem+json")
    const body = await json(response)
    expect(body).toMatchObject({ status, code })
    return body
  }

  const seedTodos = async (): Promise<void> => {
    await db.collection<Doc>("todos").insertMany([
      { _id: "a1", ownerId: "alice", title: "one", done: false, count: 1, internalNotes: "x" },
      { _id: "a2", ownerId: "alice", title: "two", done: false, count: 2 },
      { _id: "a3", ownerId: "alice", title: "three", done: true, count: 3 },
      { _id: "b1", ownerId: "bob", title: "bob", done: false, count: 4 },
    ])
  }

  describe("POST /{coll}", () => {
    it("inserts one document and returns 201, the readable post image and its Location", async () => {
      const response = await call("/todos", { body: { title: "Ship", ownerId: "alice" } })
      expect(response.status).toBe(201)
      const body = await json(response)
      const stored = await documents("todos")
      expect(stored).toHaveLength(1)
      const id = String(stored[0]?._id)
      expect(body).toMatchObject({
        data: { _id: { $oid: id }, title: "Ship", ownerId: "alice" },
        replayed: false,
      })
      expect(response.headers.get("location")).toBe(`/rest/v1/todos/${id}`)
      expect(response.headers.get("x-canopy-ct")).toBe(body["ct"])
      const read = await json(await call(`/todos/${id}`, { method: "GET" }))
      expect(ctToBigInt(read["ct"] as string) >= ctToBigInt(body["ct"] as string)).toBe(true)
    })

    it("encodes ambiguous string ids in Location as EJSON", async () => {
      const response = await call("/todos", {
        body: { _id: "6728f0c2a1b2c3d4e5f60718", title: "hex", ownerId: "alice" },
      })
      const location = response.headers.get("location") ?? ""
      expect(decodeURIComponent(location.split("/").at(-1) ?? "")).toBe(
        '"6728f0c2a1b2c3d4e5f60718"',
      )
      expect((await call(location.replace("/rest/v1", ""), { method: "GET" })).status).toBe(200)
    })

    it("inserts an array with insertMany", async () => {
      const response = await call("/todos", {
        body: [
          { _id: "m1", ownerId: "alice", title: "x" },
          { _id: "m2", ownerId: "alice", title: "y" },
        ],
      })
      expect(response.status).toBe(201)
      expect(await json(response)).toMatchObject({
        data: [
          { _id: "m1", title: "x" },
          { _id: "m2", title: "y" },
        ],
        ids: ["m1", "m2"],
      })
    })

    it("rejects inserts that are not granted, fail the check or write unwritable fields", async () => {
      await problem(
        await call("/todos", { as: "anon", body: { ownerId: "x" } }),
        403,
        ErrorCode.Forbidden,
      )
      await problem(
        await call("/todos", { body: { title: "t", ownerId: "bob" } }),
        403,
        ErrorCode.PolicyViolation,
      )
      await problem(
        await call("/todos", { body: { title: "t", ownerId: "alice", internalNotes: "x" } }),
        403,
        ErrorCode.PolicyViolation,
      )
      expect(await documents("todos")).toEqual([])
    })

    it("maps validator failures to 422 and unique index violations to 409", async () => {
      const invalid = await problem(
        await call("/strict", { body: { other: 1 } }),
        422,
        ErrorCode.ValidationFailed,
      )
      expect(invalid).not.toHaveProperty("details")
      const service = await problem(
        await call("/strict", { as: "service", body: { other: 1 } }),
        422,
        ErrorCode.ValidationFailed,
      )
      expect(service).toHaveProperty("details.reason")
      expect((await call("/strict", { body: { name: "n" } })).status).toBe(201)
      await problem(await call("/strict", { body: { name: "n" } }), 409, ErrorCode.DuplicateKey)
    })

    it("replays a repeated Idempotency-Key and refuses it to another caller", async () => {
      const headers = { "idempotency-key": "0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e" }
      const body = { _id: "k1", title: "once", ownerId: "alice" }
      const first = await json(await call("/todos", { body, headers }))
      const second = await call("/todos", { body, headers })
      expect(second.status).toBe(201)
      const replayed = await json(second)
      expect(replayed).toMatchObject({ data: first["data"], replayed: true })
      expect(await documents("todos")).toHaveLength(1)
      await problem(
        await call("/todos", { as: "bob", body: { ...body, ownerId: "bob" }, headers }),
        409,
        ErrorCode.Conflict,
      )
      await problem(
        await call("/todos", { body, headers: { "idempotency-key": "short" } }),
        400,
        ErrorCode.InvalidQuery,
      )
    })

    it("returns 204 with the cluster time header for return=minimal", async () => {
      const response = await call("/todos", {
        body: { title: "m", ownerId: "alice" },
        headers: { prefer: "return=minimal" },
      })
      expect(response.status).toBe(204)
      expect(await response.text()).toBe("")
      expect(response.headers.get("x-canopy-ct")).toMatch(/^\d+$/)
    })

    it("rejects query parameters and missing bodies", async () => {
      await problem(
        await call("/todos?x=eq.1", { body: { ownerId: "alice" } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(await call("/todos"), 400, ErrorCode.InvalidQuery)
    })
  })

  describe("PATCH, PUT and DELETE /{coll}/{id}", () => {
    beforeEach(seedTodos)

    it("updates with operators and returns the readable post image", async () => {
      const response = await call("/todos/a1", {
        method: "PATCH",
        body: { $set: { done: true }, $inc: { count: 10 } },
      })
      expect(response.status).toBe(200)
      expect((await json(response))["data"]).toEqual({
        _id: "a1",
        ownerId: "alice",
        title: "one",
        done: true,
        count: 11,
      })
    })

    it("applies a merge patch as $set and $unset", async () => {
      await db.collection<Doc>("todos").updateOne({ _id: "a2" }, { $set: { meta: { a: 1, b: 2 } } })
      const response = await call("/todos/a2", {
        method: "PATCH",
        body: { title: "patched", done: null, meta: { b: null, c: 3 } },
        headers: { "content-type": "application/merge-patch+json" },
      })
      expect(response.status).toBe(200)
      expect(await db.collection<Doc>("todos").findOne({ _id: "a2" })).toEqual({
        _id: "a2",
        ownerId: "alice",
        title: "patched",
        count: 2,
        meta: { a: 1, c: 3 },
      })
    })

    it("answers 404 for invisible documents and 409 for a failed where on a visible one", async () => {
      await problem(
        await call("/todos/b1", { method: "PATCH", body: { $set: { done: true } } }),
        404,
        ErrorCode.NotFound,
      )
      await problem(
        await call("/todos/zz", { method: "PATCH", body: { $set: { done: true } } }),
        404,
        ErrorCode.NotFound,
      )
      const where = encodeURIComponent(JSON.stringify({ done: true }))
      await problem(
        await call(`/todos/a1?where=${where}`, { method: "PATCH", body: { $set: { title: "x" } } }),
        409,
        ErrorCode.Conflict,
      )
      expect(
        (
          await call(`/todos/a3?where=${where}`, {
            method: "PATCH",
            body: { $set: { title: "x" } },
          })
        ).status,
      ).toBe(200)
      expect((await db.collection<Doc>("todos").findOne({ _id: "b1" }))?.["done"]).toBe(false)
    })

    it("rejects updates that move a document out of the check", async () => {
      await problem(
        await call("/todos/a1", { method: "PATCH", body: { $set: { ownerId: "bob" } } }),
        403,
        ErrorCode.PolicyViolation,
      )
      expect((await db.collection<Doc>("todos").findOne({ _id: "a1" }))?.["ownerId"]).toBe("alice")
    })

    it("replaces and upserts whole documents", async () => {
      await db.collection<Doc>("notes").insertOne({ _id: "n1", ownerId: "alice", text: "a" })
      const replaced = await call("/notes/n1", {
        method: "PUT",
        body: { ownerId: "alice", text: "b" },
      })
      expect(replaced.status).toBe(200)
      expect((await json(replaced))["data"]).toEqual({ _id: "n1", ownerId: "alice", text: "b" })
      await problem(
        await call("/notes/n2", { method: "PUT", body: { ownerId: "alice" } }),
        404,
        ErrorCode.NotFound,
      )
      const upserted = await call("/notes/n2?upsert=true", {
        method: "PUT",
        body: { ownerId: "alice" },
      })
      expect(upserted.status).toBe(201)
      expect(await documents("notes")).toEqual([
        { _id: "n1", ownerId: "alice", text: "b" },
        { _id: "n2", ownerId: "alice" },
      ])
      await problem(
        await call("/todos/a1", { method: "PUT", body: { ownerId: "alice", title: "t" } }),
        403,
        ErrorCode.Forbidden,
      )
      await problem(
        await call("/notes/n1?upsert=yes", { method: "PUT", body: {} }),
        400,
        ErrorCode.InvalidQuery,
      )
    })

    it("deletes a visible document and returns its readable pre image", async () => {
      const response = await call("/todos/a1", { method: "DELETE" })
      expect(response.status).toBe(200)
      expect((await json(response))["data"]).toEqual({
        _id: "a1",
        ownerId: "alice",
        title: "one",
        done: false,
        count: 1,
      })
      await problem(await call("/todos/a1", { method: "DELETE" }), 404, ErrorCode.NotFound)
      await problem(await call("/todos/b1", { method: "DELETE" }), 404, ErrorCode.NotFound)
      expect((await documents("todos")).map((row) => row._id)).toEqual(["a2", "a3", "b1"])
    })
  })

  describe("bulk PATCH and DELETE /{coll}", () => {
    beforeEach(seedTodos)

    it("needs Prefer: bulk=true and a filter", async () => {
      await problem(
        await call("/todos?done=eq.false", { method: "PATCH", body: { $set: { done: true } } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(
        await call("/todos", { method: "DELETE", headers: { prefer: "bulk=true" } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(
        await call("/todos?done=eq.false&limit=1", {
          method: "DELETE",
          headers: { prefer: "bulk=true" },
        }),
        400,
        ErrorCode.InvalidQuery,
      )
      expect(await documents("todos")).toHaveLength(4)
    })

    it("updates and deletes only the visible matches", async () => {
      const updated = await call("/todos?done=eq.false", {
        method: "PATCH",
        body: { $set: { done: true } },
        headers: { prefer: "bulk=true" },
      })
      expect(await json(updated)).toMatchObject({ data: { matched: 2, modified: 2 } })
      expect((await db.collection<Doc>("todos").findOne({ _id: "b1" }))?.["done"]).toBe(false)
      const filter = encodeURIComponent(JSON.stringify({ count: { $gte: 2 } }))
      const deleted = await call(`/todos?filter=${filter}`, {
        method: "DELETE",
        headers: { prefer: "bulk=true" },
      })
      expect(await json(deleted)).toMatchObject({ data: { deleted: 2 } })
      expect((await documents("todos")).map((row) => row._id)).toEqual(["a1", "b1"])
    })

    it("refuses bulk writes above maxBulk", async () => {
      await db
        .collection<Doc>("todos")
        .insertMany([5, 6, 7, 8].map((n) => ({ _id: `x${n}`, ownerId: "alice", done: false })))
      await problem(
        await call("/todos?done=eq.false", {
          method: "DELETE",
          headers: { prefer: "bulk=true" },
        }),
        400,
        ErrorCode.BulkLimit,
      )
      expect(await documents("todos")).toHaveLength(8)
    })
  })

  describe("POST /_batch", () => {
    beforeEach(seedTodos)

    it("commits an atomic batch in one transaction", async () => {
      const response = await call("/_batch", {
        body: {
          atomic: true,
          ops: [
            { op: "insert", c: "notes", doc: { _id: "n1", ownerId: "alice" } },
            { op: "update", c: "todos", id: "a1", update: { $set: { title: "linked" } } },
            { op: "delete", c: "todos", id: "a2" },
          ],
        },
      })
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body).toMatchObject({
        data: [
          { data: { _id: "n1", ownerId: "alice" } },
          { data: { _id: "a1", title: "linked" }, matched: 1 },
          { data: { _id: "a2" }, matched: 1 },
        ],
        replayed: false,
      })
      expect(response.headers.get("x-canopy-ct")).toBe(body["ct"])
      expect((await documents("todos")).map((row) => row._id)).toEqual(["a1", "a3", "b1"])
      expect(await documents("notes")).toHaveLength(1)
    })

    it("aborts every operation when one fails and reports its index", async () => {
      const response = await call("/_batch", {
        body: {
          atomic: true,
          ops: [
            { op: "insert", c: "notes", doc: { _id: "n1", ownerId: "alice" } },
            { op: "update", c: "todos", id: "a1", update: { $set: { ownerId: "bob" } } },
          ],
        },
      })
      const body = await problem(response, 403, ErrorCode.PolicyViolation)
      expect(body).toMatchObject({ details: { index: 1 } })
      expect(body["detail"]).toMatch(/^Operation 1: /)
      expect(await documents("notes")).toEqual([])
      expect((await db.collection<Doc>("todos").findOne({ _id: "a1" }))?.["ownerId"]).toBe("alice")
    })

    it("lets later operations see earlier ones and checks each against DLS", async () => {
      const ok = await call("/_batch", {
        body: {
          atomic: true,
          ops: [
            { op: "insert", c: "notes", doc: { _id: "n1", ownerId: "alice", v: 1 } },
            { op: "update", c: "notes", id: "n1", update: { $inc: { v: 1 } } },
          ],
        },
      })
      expect(ok.status).toBe(200)
      expect(await documents("notes")).toEqual([{ _id: "n1", ownerId: "alice", v: 2 }])
      const blocked = await call("/_batch", {
        body: { atomic: true, ops: [{ op: "delete", c: "todos", id: "b1" }] },
      })
      expect(blocked.status).toBe(200)
      expect((await json(blocked))["data"]).toEqual([{ data: null, matched: 0 }])
      expect(await documents("todos")).toHaveLength(4)
    })

    it("replays an atomic batch with the same Idempotency-Key", async () => {
      const init = {
        body: {
          atomic: true,
          ops: [{ op: "update", c: "todos", id: "a1", update: { $inc: { count: 1 } } }],
        },
        headers: { "idempotency-key": "batch-key-0001" },
      }
      expect((await json(await call("/_batch", init)))["replayed"]).toBe(false)
      const again = await json(await call("/_batch", init))
      expect(again).toMatchObject({ replayed: true, data: [{ matched: 1 }] })
      expect((await db.collection<Doc>("todos").findOne({ _id: "a1" }))?.["count"]).toBe(2)
    })

    it("runs a non atomic batch operation by operation", async () => {
      const response = await call("/_batch", {
        body: {
          ops: [
            { op: "insert", c: "notes", doc: { _id: "n1", ownerId: "alice" }, mid: "op-mid-0001" },
            { op: "insert", c: "notes", doc: { _id: "n2", ownerId: "bob" } },
            { op: "nope", c: "notes" },
          ],
        },
      })
      expect(response.status).toBe(200)
      const data = (await json(response))["data"] as Record<string, unknown>[]
      expect(data[0]).toMatchObject({ status: 200, data: { _id: "n1" }, replayed: false })
      expect(data[1]).toMatchObject({ status: 403, error: { code: ErrorCode.PolicyViolation } })
      expect(data[2]).toMatchObject({ status: 400, error: { code: ErrorCode.InvalidQuery } })
      expect(await documents("notes")).toEqual([{ _id: "n1", ownerId: "alice" }])
      const replay = await json(
        await call("/_batch", {
          body: {
            ops: [
              {
                op: "insert",
                c: "notes",
                doc: { _id: "n1", ownerId: "alice" },
                mid: "op-mid-0001",
              },
            ],
          },
        }),
      )
      expect((replay["data"] as Record<string, unknown>[])[0]).toMatchObject({
        status: 200,
        replayed: true,
      })
    })

    it("answers each operation of a non atomic batch in its place, grouped or not", async () => {
      const response = await call("/_batch", {
        body: {
          ops: [
            { op: "update", c: "todos", id: "a1", update: { $set: { title: "first" } } },
            { op: "insert", c: "notes", doc: { _id: "n1", ownerId: "alice" } },
            { op: "frobnicate", c: "todos" },
            { op: "update", c: "todos", id: "b1", update: { $set: { title: "not mine" } } },
          ],
        },
      })
      expect(response.status).toBe(200)
      const data = (await json(response))["data"] as Record<string, unknown>[]
      expect(data).toHaveLength(4)
      expect(data[0]).toMatchObject({
        status: 200,
        data: { _id: "a1", title: "first" },
        matched: 1,
        replayed: false,
      })
      expect(data[1]).toMatchObject({ status: 200, data: { _id: "n1" }, matched: 0 })
      expect(data[2]).toMatchObject({ status: 400, error: { code: ErrorCode.InvalidQuery } })
      expect(data[3]).toMatchObject({ status: 200, data: null, matched: 0 })
      for (const entry of [data[0], data[1], data[3]]) expect(typeof entry?.["ct"]).toBe("string")
      expect((await documents("todos")).map((row) => row["title"])).toEqual([
        "first",
        "two",
        "three",
        "bob",
      ])
      expect(await documents("notes")).toEqual([{ _id: "n1", ownerId: "alice" }])
    })

    it("validates the batch shape and limits", async () => {
      const ops = [1, 2, 3, 4, 5].map((n) => ({
        op: "insert",
        c: "notes",
        doc: { ownerId: "alice", n },
      }))
      await problem(
        await call("/_batch", { body: { atomic: true, ops } }),
        400,
        ErrorCode.BulkLimit,
      )
      await problem(await call("/_batch", { body: { ops } }), 400, ErrorCode.BulkLimit)
      await problem(
        await call("/_batch", { body: { atomic: true, ops: [] } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(
        await call("/_batch", { body: { atomic: "yes", ops: [] } }),
        400,
        ErrorCode.InvalidQuery,
      )
      const bulk = await problem(
        await call("/_batch", {
          body: { atomic: true, ops: [{ op: "deleteMany", c: "todos", filter: { done: false } }] },
        }),
        400,
        ErrorCode.InvalidQuery,
      )
      expect(bulk).toMatchObject({ details: { index: 0 } })
      const withBulk = await call("/_batch", {
        body: { atomic: true, ops: [{ op: "deleteMany", c: "todos", filter: { done: false } }] },
        headers: { prefer: "bulk=true" },
      })
      expect((await json(withBulk))["data"]).toEqual([{ data: { deleted: 2 } }])
      await problem(
        await call("/_batch", {
          body: { atomic: true, ops: [{ op: "insert", c: "notes", doc: {}, mid: "op-mid-0002" }] },
        }),
        400,
        ErrorCode.InvalidQuery,
      )
      expect(await documents("notes")).toEqual([])
    })
  })

  it("lists the methods each path allows", async () => {
    const response = await call("/todos", { method: "PUT", body: {} })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET, POST, PATCH, DELETE")
    const item = await call("/todos/a1", { method: "POST", body: {} })
    expect(item.headers.get("allow")).toBe("GET, PATCH, PUT, DELETE")
  })

  it("keeps the generated ObjectId type", async () => {
    const response = await json(await call("/todos", { body: { ownerId: "alice" } }))
    const stored = await db.collection<Document>("todos").findOne({})
    expect(stored?.["_id"]).toBeInstanceOf(BSON.ObjectId)
    expect(response["data"]).toMatchObject({
      _id: { $oid: String(stored?.["_id"]) },
    })
  })
})
