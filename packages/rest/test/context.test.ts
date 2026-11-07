import { Authenticator } from "@canopy/auth"
import {
  allow,
  auth,
  ContextResolver,
  collection,
  context,
  createPolicySet,
  ctx,
  PolicyEngine,
} from "@canopy/policy"
import { ErrorCode } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createRestHandler, mongoContextReader, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const BASE = "http://canopy.test/rest/v1"

const mine = { projectId: { $in: ctx("projectIds") } }
const tasks = collection("tasks", {
  exposed: true,
  policies: [
    allow.read("authenticated").where(mine),
    allow.insert("authenticated").check(mine),
    allow.update("authenticated").where(mine).check(mine),
    allow.delete("authenticated").where(mine),
  ],
})
const contexts = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 10,
    ttl: "5m",
  },
})

type Row = { _id: string; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("context lookups in the REST API", () => {
  const dbName = `canopy_rest_ctx_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let client: MongoClient
  let db: Db
  let resolver: ContextResolver
  let rest: RestHandler
  let tokens: Record<string, string>
  let authenticator: Authenticator

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.createCollection("tasks")
    await db.createCollection("members")
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
    authenticator = new Authenticator(
      { jwks: { keys: [jwk] }, issuer: ISSUER },
      { publishable: [PUBLISHABLE] },
    )
    resolver = new ContextResolver({ reader: mongoContextReader(db) })
    rest = handler(resolver)
  })

  afterAll(async () => {
    resolver.close()
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    resolver.invalidateAll()
    await db.collection("members").deleteMany({})
    await db.collection("tasks").deleteMany({})
    await db.collection<Row>("tasks").insertMany([
      { _id: "t1", projectId: "p1", title: "one" },
      { _id: "t2", projectId: "p2", title: "two" },
    ])
    await db.collection<Row>("members").insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
  })

  const handler = (contextResolver: ContextResolver): RestHandler =>
    createRestHandler({
      client,
      database: dbName,
      metaDatabase: metaName,
      policies: new PolicyEngine(createPolicySet([tasks], contexts)),
      authenticator,
      contexts: contextResolver,
    })

  const call = (
    path: string,
    init: { as?: string; method?: string; body?: unknown; via?: RestHandler } = {},
  ): Promise<Response> =>
    (init.via ?? rest).fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          apikey: PUBLISHABLE,
          authorization: `Bearer ${tokens[init.as ?? "alice"]}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )

  const ids = async (response: Response): Promise<string[]> => {
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Row[] }
    return body.data.map((row) => row._id).sort()
  }

  const code = async (response: Response): Promise<unknown> =>
    ((await response.json()) as Record<string, unknown>)["code"]

  it("reads only the documents of the caller's memberships", async () => {
    expect(await ids(await call("/tasks"))).toEqual(["t1"])
    expect(await ids(await call("/tasks", { as: "bob" }))).toEqual([])
    expect((await call("/tasks/t2")).status).toBe(404)
  })

  it("applies the lookups to count and aggregate", async () => {
    const count = await call("/tasks/_count", { method: "POST", body: {} })
    expect(((await count.json()) as { data: { count: number } }).data.count).toBe(1)
    const aggregate = await call("/tasks/_aggregate", {
      method: "POST",
      body: { pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }] },
    })
    expect(((await aggregate.json()) as { data: { n: number }[] }).data).toEqual([
      { _id: null, n: 1 },
    ])
  })

  it("enforces the lookups on writes: using for targets and check for results", async () => {
    expect(
      (await call("/tasks/t1", { method: "PATCH", body: { $set: { title: "edited" } } })).status,
    ).toBe(200)
    expect((await call("/tasks/t2", { method: "DELETE" })).status).toBe(404)
    const moved = await call("/tasks/t1", {
      method: "PATCH",
      body: { $set: { projectId: "p2" } },
    })
    expect(moved.status).toBe(403)
    expect(await code(moved)).toBe(ErrorCode.PolicyViolation)
    const inserted = await call("/tasks", { method: "POST", body: { _id: "t3", projectId: "p2" } })
    expect(inserted.status).toBe(403)
    expect(await db.collection<Row>("tasks").countDocuments({ _id: "t3" })).toBe(0)
    expect((await db.collection<Row>("tasks").findOne({ _id: "t1" }))?.["projectId"]).toBe("p1")
  })

  it("resolves the lookups of every collection in a batch", async () => {
    const response = await call("/_batch", {
      method: "POST",
      body: {
        atomic: true,
        ops: [
          { op: "insert", c: "tasks", doc: { _id: "t4", projectId: "p1" } },
          { op: "insert", c: "tasks", doc: { _id: "t5", projectId: "p2" } },
        ],
      },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: ErrorCode.PolicyViolation,
      details: { index: 1 },
    })
    expect(await db.collection<Row>("tasks").countDocuments({ _id: { $in: ["t4", "t5"] } })).toBe(0)
  })

  it("sees a membership change once the shared resolver is invalidated", async () => {
    expect(await ids(await call("/tasks"))).toEqual(["t1"])
    const member = { _id: "m2", userId: "alice", projectId: "p2" }
    await db.collection<Row>("members").insertOne(member)
    expect(await ids(await call("/tasks"))).toEqual(["t1"])
    resolver.invalidate({ coll: "members", id: "m2", pre: null, post: member })
    expect(await ids(await call("/tasks"))).toEqual(["t1", "t2"])
  })

  it("denies a member whose lookup cannot be read", async () => {
    const failing = new ContextResolver({ reader: () => Promise.reject(new Error("unreachable")) })
    const via = handler(failing)
    expect(await ids(await call("/tasks", { via }))).toEqual([])
    expect((await call("/tasks/t1", { via, method: "DELETE" })).status).toBe(404)
    expect(await db.collection<Row>("tasks").countDocuments({ _id: "t1" })).toBe(1)
    failing.close()
  })
})
