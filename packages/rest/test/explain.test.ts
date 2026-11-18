import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, context, createPolicySet, ctx, restrict } from "@canopy/policy"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"
const BASE = "http://canopy.test/rest/v1"

const lookups = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 100,
    ttl: "1m",
  },
})

const tasks = collection("tasks", {
  exposed: true,
  policies: [
    allow
      .read("authenticated")
      .where({ projectId: { $in: ctx("projectIds") } })
      .named("in my projects"),
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("own tasks"),
    allow
      .delete("authenticated")
      .where({ ownerId: auth("sub") })
      .named("delete own"),
    restrict
      .delete("authenticated")
      .where({ locked: { $ne: true } })
      .named("locked stays"),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("POST /{coll}/_explain", () => {
  const dbName = `canopy_rest_explain_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let token = ""

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection("members").insertMany([
      { userId: "alice", projectId: "p1" },
      { userId: "bob", projectId: "p2" },
    ])
    await db.collection("tasks").insertMany([
      { projectId: "p1", ownerId: "bob", done: true },
      { projectId: "p1", ownerId: "bob", done: false },
      { projectId: "p2", ownerId: "alice", done: true },
      { projectId: "p2", ownerId: "bob", done: true },
      { projectId: "p3", ownerId: "carol", done: true, locked: true },
    ])
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
      policies: testPolicyEngine(createPolicySet([tasks], lookups)),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  const call = (
    body: unknown,
    as: "service" | "user" | "anon" = "service",
    path = "/tasks/_explain",
  ): Promise<Response> =>
    rest.fetch(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          apikey: as === "service" ? SECRET : PUBLISHABLE,
          ...(as === "user" ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    )

  it("explains a read for stated claims, resolving context lookups and counting documents", async () => {
    const response = await call({ claims: { sub: "alice" }, filter: { done: true }, count: true })
    expect(response.status).toBe(200)
    const data = ((await response.json()) as { data: Record<string, unknown> }).data
    expect(data["effectiveFilter"]).toEqual({
      $and: [{ done: true }, { $or: [{ projectId: { $in: ["p1"] } }, { ownerId: "alice" }] }],
    })
    expect(data["count"]).toBe(2)
    expect(data["granted"]).toBe(true)
    expect(data["readable"]).toEqual({ kind: "omit", paths: ["secret"] })
    expect(String(data["text"]).split("\n").slice(0, 4)).toEqual([
      "tasks, read, roles [authenticated]",
      '  permissive  "in my projects"  matches   {"projectId":{"$in":["p1"]}}',
      '  permissive  "own tasks"       matches   {"ownerId":"alice"}',
      "  restrictive (none)",
    ])
  })

  it("explains writes and stated context values", async () => {
    const response = await call({
      claims: { sub: "carol" },
      op: "delete",
      ctx: { projectIds: [] },
      count: true,
    })
    const data = ((await response.json()) as { data: Record<string, unknown> }).data
    expect(String(data["text"])).toContain(
      '  restrictive "locked stays"  matches   {"locked":{"$ne":true}}',
    )
    expect(data["count"]).toBe(0)
    const anon = await call({ count: true })
    const anonData = ((await anon.json()) as { data: Record<string, unknown> }).data
    expect(anonData["roles"]).toEqual(["anon"])
    expect(anonData["effectiveFilter"]).toEqual({ _id: { $in: [] } })
    expect(anonData["count"]).toBe(0)
  })

  it("never explains to publishable keys or user tokens", async () => {
    for (const as of ["anon", "user"] as const) {
      for (const body of [{ claims: { sub: "alice" } }, "{not json", { nope: 1 }]) {
        const response = await call(body, as)
        expect(response.status).toBe(403)
        const text = await response.text()
        expect(JSON.parse(text)).toMatchObject({ code: "CANOPY_FORBIDDEN" })
        expect(text).not.toContain("in my projects")
        expect(text).not.toContain("projectId")
      }
    }
  })

  it("rejects malformed requests from service callers", async () => {
    expect((await call({ op: "upsert" })).status).toBe(400)
    expect((await call({ claims: "alice" })).status).toBe(400)
    expect((await call({ roles: [1] })).status).toBe(400)
    expect((await call({ extra: true })).status).toBe(400)
    expect((await call({ count: "yes" })).status).toBe(400)
    expect((await call([])).status).toBe(400)
  })
})
