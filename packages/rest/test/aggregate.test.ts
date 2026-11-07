import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { ErrorCode } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"

const orders = collection("orders", {
  exposed: true,
  policies: [allow.read("authenticated").where({ customerId: auth("sub") })],
  fields: { read: { default: { omit: ["card"] } } },
})

const customers = collection("customers", {
  exposed: true,
  policies: [allow.read("authenticated").where({ _id: auth("sub") })],
  fields: { read: { default: { only: ["name"] } } },
})

const open = collection("open", { exposed: true, policies: [allow.read("public")] })
const internal = collection("internal", { exposed: false, policies: [allow.read("authenticated")] })

type Doc = { _id: string; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

/** Every value a caller other than service must never see contains this marker. */
const MARK = "LEAK"

suite("REST aggregation against MongoDB", () => {
  const dbName = `canopy_rest_agg_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let token: string

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection<Doc>("orders").insertMany([
      { _id: "o1", customerId: "alice", total: 10, card: { number: `${MARK}-card-1` } },
      { _id: "o2", customerId: "alice", total: 20, card: { number: `${MARK}-card-2` } },
      { _id: "o3", customerId: "alice", total: 5, card: { number: `${MARK}-card-3` } },
      { _id: `${MARK}-o4`, customerId: `${MARK}-bob`, total: 99, card: { number: `${MARK}-c4` } },
    ])
    await db.collection<Doc>("customers").insertMany([
      { _id: "alice", name: "Alice", email: `${MARK}-alice@example.test` },
      { _id: `${MARK}-bob`, name: `${MARK}-Bob`, email: `${MARK}-bob@example.test` },
    ])
    await db.collection<Doc>("open").insertMany([{ _id: "p1" }, { _id: "p2" }, { _id: "p3" }])
    await db.collection<Doc>("internal").insertOne({ _id: `${MARK}-i1` })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey)
    rest = createRestHandler({
      client,
      database: dbName,
      policies: new PolicyEngine(createPolicySet([orders, customers, open, internal])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
      readLimits: { maxAggregateResults: 6 },
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  const aggregate = (pipeline: unknown, as: "alice" | "service" = "alice"): Promise<Response> =>
    rest.fetch(
      new Request(`http://canopy.test/rest/v1/orders/_aggregate`, {
        method: "POST",
        headers: {
          apikey: as === "service" ? SECRET : PUBLISHABLE,
          ...(as === "alice" ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ pipeline }),
      }),
    )

  const data = async (pipeline: unknown): Promise<unknown[]> => {
    const response = await aggregate(pipeline)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(text).not.toContain(MARK)
    return (JSON.parse(text) as { data: unknown[] }).data
  }

  it("returns only readable fields of visible documents", async () => {
    expect(await data([{ $sort: { _id: 1 } }])).toEqual([
      { _id: "o1", customerId: "alice", total: 10 },
      { _id: "o2", customerId: "alice", total: 20 },
      { _id: "o3", customerId: "alice", total: 5 },
    ])
  })

  it("aggregates over visible documents only", async () => {
    expect(
      await data([{ $group: { _id: null, sum: { $sum: "$total" }, n: { $sum: 1 } } }]),
    ).toEqual([{ _id: null, sum: 35, n: 3 }])
  })

  it("leaks nothing through adversarial pipelines", async () => {
    const corpus: unknown[][] = [
      [{ $replaceRoot: { newRoot: "$$ROOT" } }],
      [{ $group: { _id: null, cards: { $push: "$card" }, all: { $push: "$$ROOT" } } }],
      [{ $addFields: { c: "$card.number", whole: "$$CURRENT" } }],
      [{ $project: { kv: { $objectToArray: "$$ROOT" } } }],
      [{ $lookup: { from: "orders", pipeline: [], as: "all" } }],
      [
        {
          $lookup: {
            from: "orders",
            localField: "customerId",
            foreignField: "customerId",
            as: "same",
          },
        },
      ],
      [{ $lookup: { from: "customers", localField: "customerId", foreignField: "_id", as: "c" } }],
      [{ $lookup: { from: "customers", pipeline: [{ $project: { email: 1 } }], as: "c" } }],
      [
        {
          $lookup: {
            from: "orders",
            let: { x: "$card" },
            pipeline: [{ $match: { $expr: { $ne: ["$card", "$$x"] } } }],
            as: "m",
          },
        },
      ],
      [{ $unionWith: "customers" }],
      [{ $unionWith: { coll: "orders", pipeline: [{ $match: {} }] } }],
      [
        {
          $facet: {
            a: [{ $lookup: { from: "orders", pipeline: [{ $unionWith: "customers" }], as: "x" } }],
            b: [{ $sortByCount: "$customerId" }],
          },
        },
      ],
      [{ $match: { "card.number": { $regex: MARK } } }],
      [{ $match: { $expr: { $gt: [{ $strLenCP: { $ifNull: ["$card.number", ""] } }, 0] } } }],
      [
        {
          $setWindowFields: {
            sortBy: { total: 1 },
            output: { ids: { $push: "$_id", window: { documents: ["unbounded", "unbounded"] } } },
          },
        },
      ],
      [{ $unwind: { path: "$card", preserveNullAndEmptyArrays: true } }],
      [{ $sample: { size: 5 } }],
    ]
    for (const pipeline of corpus) await data(pipeline)
  })

  it("keeps the joined documents to the foreign collection's policy", async () => {
    expect(
      await data([
        { $match: { _id: "o1" } },
        { $lookup: { from: "orders", pipeline: [{ $count: "n" }], as: "visible" } },
        { $lookup: { from: "customers", pipeline: [], as: "me" } },
        { $project: { visible: 1, me: 1 } },
      ]),
    ).toEqual([{ _id: "o1", visible: [{ n: 3 }], me: [{ _id: "alice", name: "Alice" }] }])
  })

  it("rejects stages and expressions that could bypass DLS or write", async () => {
    const rejected: unknown[][] = [
      [{ $out: "stolen" }],
      [{ $merge: { into: "stolen" } }],
      [
        {
          $graphLookup: {
            from: "orders",
            startWith: "$_id",
            connectFromField: "_id",
            connectToField: "_id",
            as: "g",
          },
        },
      ],
      [
        {
          $lookup: { from: "customers", localField: "customerId", foreignField: "email", as: "c" },
        },
      ],
      [{ $lookup: { from: "internal", pipeline: [], as: "i" } }],
      [{ $unionWith: "internal" }],
      [{ $lookup: { from: "orders", pipeline: [{ $unionWith: "internal" }], as: "x" } }],
      [{ $addFields: { roles: "$$USER_ROLES" } }],
      [
        {
          $project: { x: { $function: { body: "function() { return 1 }", args: [], lang: "js" } } },
        },
      ],
      [{ $match: { $where: "true" } }],
      [{ $collStats: { count: {} } }],
    ]
    for (const pipeline of rejected) {
      const response = await aggregate(pipeline)
      const text = await response.text()
      expect(response.status, JSON.stringify(pipeline)).toBe(400)
      expect(JSON.parse(text)).toMatchObject({ code: ErrorCode.InvalidQuery })
      expect(text).not.toContain(MARK)
    }
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
    expect(names).not.toContain("stolen")
  })

  it("caps the number of results", async () => {
    const response = await aggregate([{ $unionWith: "open" }, { $unionWith: "open" }])
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: ErrorCode.InvalidQuery })
    expect(await data([{ $unionWith: "open" }])).toHaveLength(6)
  })

  it("lets service see everything", async () => {
    const response = await aggregate(
      [{ $match: { _id: `${MARK}-o4` } }, { $project: { card: 1 } }],
      "service",
    )
    expect(await response.json()).toMatchObject({
      data: [{ _id: `${MARK}-o4`, card: { number: `${MARK}-c4` } }],
    })
  })
})
