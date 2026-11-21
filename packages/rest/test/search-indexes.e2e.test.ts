import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { testPolicyEngine } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createRestHandler,
  probeSearch,
  type RestHandler,
  searchDiagnostics,
} from "../src/index.ts"

/**
 * A deployment with MongoDB Search, such as the `mongodb/mongodb-atlas-local` image the nightly job starts:
 * `mongodb://localhost:27017/?directConnection=true`. The search-unavailable case runs in `search.test.ts`
 * against the plain replica set.
 */
const SEARCH_URI = process.env["CANOPY_TEST_SEARCH_URI"]
const suite = SEARCH_URI === undefined ? describe.skip : describe
const ISSUER = "https://idp.search.test/"
const PUBLISHABLE = "canopy_pk_search"

interface Product {
  _id: string
  ownerId: string
  name: string
  embedding: number[]
}

const PRODUCTS: Product[] = [
  { _id: "a1", ownerId: "alice", name: "desk lamp with a brass arm", embedding: [1, 0, 0] },
  { _id: "a2", ownerId: "alice", name: "oak writing desk", embedding: [0, 1, 0] },
  { _id: "a3", ownerId: "alice", name: "wool rug", embedding: [0, 0, 1] },
  { _id: "b1", ownerId: "bob", name: "floor lamp", embedding: [0.9, 0.1, 0] },
  { _id: "b2", ownerId: "bob", name: "standing desk", embedding: [0.1, 0.9, 0] },
]

const products = collection("products", {
  exposed: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

suite("search with ready text and vector indexes, under each caller's policies", () => {
  const dbName = `canopy_search_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  const tokens = new Map<string, string>()

  beforeAll(async () => {
    client = new MongoClient(SEARCH_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection<Product>("products").insertMany(PRODUCTS)
    await db.collection("products").createSearchIndexes([
      {
        name: "names",
        definition: { mappings: { dynamic: false, fields: { name: { type: "string" } } } },
      },
      {
        name: "embeddings",
        type: "vectorSearch",
        definition: {
          fields: [{ type: "vector", path: "embedding", numDimensions: 3, similarity: "cosine" }],
        },
      },
    ])
    const deadline = Date.now() + 180_000
    for (;;) {
      const capability = await probeSearch(db, ["products"])
      const indexes = capability.available ? (capability.collections[0]?.indexes ?? []) : []
      if (indexes.length === 2 && indexes.every((index) => index.queryable)) break
      if (Date.now() > deadline)
        throw new Error(`search indexes not ready: ${JSON.stringify(capability)}`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    for (const sub of ["alice", "bob"])
      tokens.set(
        sub,
        await new SignJWT({ sub })
          .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
          .setIssuer(ISSUER)
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(pair.privateKey),
      )
    rest = createRestHandler({
      client,
      database: dbName,
      policies: testPolicyEngine(createPolicySet([products])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [] },
      ),
      search: ["products"],
    })
  }, 240_000)

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  const ids = async (sub: string, pipeline: unknown[]): Promise<string[]> => {
    const response = await rest.fetch(
      new Request("http://canopy.test/rest/v1/products/_aggregate", {
        method: "POST",
        headers: {
          apikey: PUBLISHABLE,
          authorization: `Bearer ${tokens.get(sub)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ pipeline }),
      }),
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { _id: string }[] }).data.map((doc) => doc._id)
  }

  it("reports both indexes as queryable to canopy doctor and Studio", async () => {
    const capability = await probeSearch(db, ["products"])
    expect(capability).toEqual({
      available: true,
      collections: [
        {
          name: "products",
          indexes: expect.arrayContaining([
            expect.objectContaining({ name: "names", queryable: true }),
            expect.objectContaining({ name: "embeddings", type: "vectorSearch", queryable: true }),
          ]),
        },
      ],
    })
    expect(searchDiagnostics(capability, 1).every((line) => line.status === "ok")).toBe(true)
  })

  it("finds text matches only among the caller's documents", async () => {
    const lamp = [{ $search: { index: "names", text: { query: "lamp", path: "name" } } }]
    expect(await ids("alice", lamp)).toEqual(["a1"])
    expect(await ids("bob", lamp)).toEqual(["b1"])
    const desk = [{ $search: { index: "names", text: { query: "desk", path: "name" } } }]
    expect((await ids("alice", desk)).sort()).toEqual(["a1", "a2"])
    expect(await ids("bob", desk)).toEqual(["b2"])
  })

  it("ranks vector neighbours only among the caller's documents", async () => {
    const near = [
      {
        $vectorSearch: {
          index: "embeddings",
          path: "embedding",
          queryVector: [1, 0.05, 0],
          numCandidates: 10,
          limit: 10,
        },
      },
    ]
    expect(await ids("alice", near)).toEqual(["a1", "a2", "a3"])
    expect(await ids("bob", near)).toEqual(["b1", "b2"])
  })
})
