import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type CommandStartedEvent, type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"

const orders = collection("orders", {
  exposed: true,
  policies: [allow.read("authenticated").where({ customerId: auth("sub") })],
  fields: { read: { default: { omit: ["card"] } } },
})
const open = collection("open", { exposed: true, policies: [allow.read("public")] })

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("REST search stages against MongoDB", () => {
  const dbName = `canopy_rest_search_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let token: string
  const sent: CommandStartedEvent[] = []

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    client.on("commandStarted", (event) => {
      if (event.commandName === "aggregate") sent.push(event)
    })
    await client.connect()
    db = client.db(dbName)
    await db.collection("orders").insertOne({ _id: "o1" as never, customerId: "alice" })
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
      policies: new PolicyEngine(createPolicySet([orders, open])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [] },
      ),
      readLimits: { maxAggregateResults: 6 },
      search: ["orders"],
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  beforeEach(() => {
    sent.length = 0
  })

  const aggregate = (collectionName: string, pipeline: unknown): Promise<Response> =>
    rest.fetch(
      new Request(`http://canopy.test/rest/v1/${collectionName}/_aggregate`, {
        method: "POST",
        headers: {
          apikey: PUBLISHABLE,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ pipeline }),
      }),
    )

  it("sends the search first, then the policy, outside a snapshot", async () => {
    const response = await aggregate("orders", [
      { $search: { text: { query: "lamp", path: "item" } } },
      { $project: { item: 1, score: { $meta: "searchScore" } } },
    ])
    const [command] = sent
    expect(command?.command["pipeline"]).toEqual([
      { $search: { text: { query: "lamp", path: "item" } } },
      { $match: { customerId: "alice" } },
      { $project: { card: 0 } },
      { $project: { item: 1, score: { $meta: "searchScore" } } },
      { $limit: 7 },
    ])
    expect(command?.command["readConcern"]?.["level"]).not.toBe("snapshot")
    // A replica set without MongoDB Search answers SearchNotEnabled; Atlas would answer 200.
    if (response.status !== 200) {
      expect(response.status).toBe(503)
      expect(((await response.json()) as { detail: string }).detail).toMatch(
        /Search is not available on this MongoDB deployment/,
      )
    }
  })

  it("refuses a search on an unreadable field before anything reaches MongoDB", async () => {
    const response = await aggregate("orders", [
      { $search: { text: { query: "4111", path: "card.number" } } },
    ])
    expect(response.status).toBe(400)
    expect(((await response.json()) as { detail: string }).detail).toMatch(
      /unreadable field card.number/,
    )
    expect(sent).toEqual([])
  })

  it("refuses search on a collection without search turned on", async () => {
    const response = await aggregate("open", [{ $search: { text: { query: "x", path: "a" } } }])
    expect(response.status).toBe(400)
    expect(((await response.json()) as { detail: string }).detail).toMatch(/not allowed here/)
    expect(sent).toEqual([])
  })
})
