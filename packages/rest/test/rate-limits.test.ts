import { Authenticator, RateLimits } from "@canopy/auth"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { ErrorCode } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_limits"
const SECRET = "canopy_sk_limits"
const BASE = "http://canopy.test/rest/v1"

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow.read("anon"),
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("REST rate limits against MongoDB", () => {
  const dbName = `canopy_rest_limits_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let tokens: Record<"alice" | "bob", string>
  let authenticator: Authenticator
  let policies: PolicyEngine

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection("todos").insertOne({ title: "one", ownerId: "alice" })
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
      { publishable: [PUBLISHABLE], secret: [SECRET] },
    )
    policies = new PolicyEngine(createPolicySet([todos]))
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  function setup(options: { exemptService?: boolean; limits?: boolean; trusted?: string[] } = {}) {
    let now = 5_000_000
    const limits = new RateLimits({
      requests: { perSecond: 1, burst: 3 },
      messages: { perSecond: 1, burst: 1 },
      anonymousConnectionsPerAddress: 1,
      now: () => now,
      ...(options.exemptService === undefined ? {} : { exemptService: options.exemptService }),
      ...(options.trusted === undefined ? {} : { trustedProxies: options.trusted }),
    })
    const refused: number[] = []
    const rest: RestHandler = createRestHandler({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies,
      authenticator,
      ...(options.limits === false
        ? {}
        : { rateLimits: limits, onRateLimited: () => refused.push(now) }),
    })
    const call = (
      as: "alice" | "bob" | "anon" | "service",
      ip?: string,
      headers: Record<string, string> = {},
    ): Promise<Response> =>
      rest.fetch(
        new Request(`${BASE}/todos`, {
          headers: {
            apikey: as === "service" ? SECRET : PUBLISHABLE,
            ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
            ...headers,
          },
        }),
        ip === undefined ? {} : { ip },
      )
    return {
      call,
      refused,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it("answers 429 with Retry-After and the CANOPY_RATE_LIMITED problem once the burst is spent", async () => {
    const { call, refused } = setup()
    for (let i = 0; i < 3; i++) expect((await call("alice", "198.51.100.1")).status).toBe(200)
    const response = await call("alice", "198.51.100.1")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("1")
    expect(response.headers.get("content-type")).toBe("application/problem+json")
    expect(await response.json()).toMatchObject({
      status: 429,
      code: ErrorCode.RateLimited,
      title: "Rate limited",
      details: { retryAfterSeconds: 1 },
    })
    expect(refused).toHaveLength(1)
  })

  it("accepts the caller again once the bucket has refilled", async () => {
    const { call, advance } = setup()
    for (let i = 0; i < 3; i++) await call("alice")
    expect((await call("alice")).status).toBe(429)
    advance(999)
    expect((await call("alice")).status).toBe(429)
    advance(1)
    expect((await call("alice")).status).toBe(200)
    expect((await call("alice")).status).toBe(429)
  })

  it("budgets each signed in subject on its own, whatever the address", async () => {
    const { call } = setup()
    for (let i = 0; i < 3; i++) await call("alice", "198.51.100.1")
    expect((await call("alice", "198.51.100.2")).status).toBe(429)
    expect((await call("bob", "198.51.100.1")).status).toBe(200)
  })

  it("limits anonymous callers per address, since they all share one key", async () => {
    const { call } = setup()
    for (let i = 0; i < 3; i++) expect((await call("anon", "198.51.100.1")).status).not.toBe(429)
    expect((await call("anon", "198.51.100.1")).status).toBe(429)
    expect((await call("anon", "198.51.100.2")).status).not.toBe(429)
  })

  it("takes the address behind a trusted proxy from X-Forwarded-For, and ignores the header otherwise", async () => {
    const behind = setup({ trusted: ["10.0.0.0/8"] })
    const forwarded = (address: string) => ({ "x-forwarded-for": address })
    for (let i = 0; i < 3; i++) await behind.call("anon", "10.0.0.1", forwarded("203.0.113.7"))
    expect((await behind.call("anon", "10.0.0.1", forwarded("203.0.113.7"))).status).toBe(429)
    expect((await behind.call("anon", "10.0.0.1", forwarded("203.0.113.8"))).status).not.toBe(429)

    const direct = setup({ trusted: ["10.0.0.0/8"] })
    for (let i = 0; i < 3; i++) await direct.call("anon", "192.0.2.9", forwarded(`203.0.113.${i}`))
    expect((await direct.call("anon", "192.0.2.9", forwarded("203.0.113.99"))).status).toBe(429)
  })

  it("exempts the service role, unless the limits say otherwise", async () => {
    const exempt = setup()
    for (let i = 0; i < 30; i++) expect((await exempt.call("service")).status).toBe(200)
    const strict = setup({ exemptService: false })
    for (let i = 0; i < 3; i++) await strict.call("service")
    expect((await strict.call("service")).status).toBe(429)
  })

  it("serves every request when no limits are configured", async () => {
    const { call, refused } = setup({ limits: false })
    for (let i = 0; i < 30; i++) expect((await call("alice")).status).toBe(200)
    expect(refused).toEqual([])
  })

  it("does not count requests that fail to authenticate", async () => {
    const { call } = setup()
    for (let i = 0; i < 10; i++) {
      const response = await call("alice", undefined, { apikey: "wrong" })
      expect(response.status).toBe(401)
    }
    expect((await call("alice")).status).toBe(200)
  })
})
