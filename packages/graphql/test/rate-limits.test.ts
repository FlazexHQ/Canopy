import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Authenticator, RateLimits } from "@canopy/auth"
import {
  allow,
  auth,
  ContextResolver,
  collection,
  createPolicySet,
  type PolicyEngine,
} from "@canopy/policy"
import { createRealtime, type Realtime } from "@canopy/realtime"
import { createRestHandler, mongoContextReader, SchemaCache } from "@canopy/rest"
import { MONGODB_URI, TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { createClient as createWsClient } from "graphql-ws"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import {
  attachGraphqlWs,
  createGraphqlHandler,
  type GraphqlHandler,
  type GraphqlWsAttachment,
} from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_gql_limits"
const SECRET = "canopy_sk_gql_limits"
const URL_BASE = "http://canopy.test/graphql/v1"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("anon"), allow.read("authenticated").where({ ownerId: auth("sub") })],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("GraphQL rate limits against MongoDB", () => {
  const dbName = `canopy_graphql_limits_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let realtime: Realtime
  let tokens: Record<"alice" | "bob", string>
  let authenticator: Authenticator
  let rest: ReturnType<typeof createRestHandler>
  let policies: PolicyEngine
  const handlers: GraphqlHandler[] = []
  const servers: { server: Server; attachment: GraphqlWsAttachment }[] = []

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
    const set = createPolicySet([todos])
    policies = testPolicyEngine(set)
    rest = createRestHandler({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies,
      authenticator,
    })
    realtime = await createRealtime({
      engine: TEST_ENGINE,
      mongo: client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      authenticator,
      policies: { set },
      checkpoints: "off",
      observerLingerMs: 0,
    })
  })

  afterAll(async () => {
    for (const handler of handlers) handler.close()
    for (const { server, attachment } of servers) {
      await attachment.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await realtime?.close({ drainMs: 0 })
    await db?.dropDatabase()
    await client?.db(`${dbName}_meta`).dropDatabase()
    await client?.close()
  })

  function setup(
    options: { exemptService?: boolean; limited?: boolean; cors?: boolean; failures?: number } = {},
  ) {
    let now = 9_000_000
    const refused: number[] = []
    const limits = new RateLimits({
      requests: { perSecond: 1, burst: 3 },
      messages: { perSecond: 1, burst: 1 },
      anonymousConnectionsPerAddress: 1,
      now: () => now,
      ...(options.failures === undefined
        ? {}
        : { failedAuthentications: { perSecond: 1, burst: options.failures } }),
      ...(options.exemptService === undefined ? {} : { exemptService: options.exemptService }),
    })
    const graphql = createGraphqlHandler({
      reads: rest.reads,
      writes: rest.writes,
      policies,
      authenticator,
      contexts: new ContextResolver({ reader: mongoContextReader(db) }),
      schemas: new SchemaCache(db),
      realtime,
      ...(options.limited === false
        ? {}
        : { rateLimits: limits, onRateLimited: () => refused.push(now) }),
      ...(options.cors === true ? { cors: { origins: ["https://app.example.test"] } } : {}),
    })
    handlers.push(graphql)
    const post = (
      as: "alice" | "bob" | "anon" | "service",
      ip?: string,
      headers: Record<string, string> = {},
    ) =>
      graphql.fetch(
        new Request(URL_BASE, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: as === "service" ? SECRET : PUBLISHABLE,
            ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
            ...headers,
          },
          body: JSON.stringify({ query: "{ todosCount }" }),
        }),
        ip === undefined ? {} : { ip },
      )
    return {
      graphql,
      post,
      refused,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it("answers 429 with Retry-After and the CANOPY_RATE_LIMITED error, then recovers", async () => {
    const { post, refused, advance } = setup()
    for (let i = 0; i < 3; i++) expect((await post("alice")).status).toBe(200)
    const response = await post("alice")
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("1")
    expect(await response.json()).toMatchObject({
      errors: [{ extensions: { code: "CANOPY_RATE_LIMITED", details: { retryAfterSeconds: 1 } } }],
    })
    expect(refused).toHaveLength(1)
    advance(1000)
    expect((await post("alice")).status).toBe(200)
  })

  it("keeps signed in callers apart and limits anonymous callers per address", async () => {
    const { post } = setup()
    for (let i = 0; i < 3; i++) await post("alice", "198.51.100.1")
    expect((await post("alice", "198.51.100.2")).status).toBe(429)
    expect((await post("bob", "198.51.100.1")).status).toBe(200)
    for (let i = 0; i < 3; i++) await post("anon", "198.51.100.1")
    expect((await post("anon", "198.51.100.1")).status).toBe(429)
    expect((await post("anon", "198.51.100.2")).status).toBe(200)
  })

  it("exempts the service role and serves everything without limits", async () => {
    const exempt = setup()
    for (let i = 0; i < 20; i++) expect((await exempt.post("service")).status).toBe(200)
    const strict = setup({ exemptService: false })
    for (let i = 0; i < 3; i++) await strict.post("service")
    expect((await strict.post("service")).status).toBe(429)
    const off = setup({ limited: false })
    for (let i = 0; i < 20; i++) expect((await off.post("alice")).status).toBe(200)
  })

  it("leaves requests that fail to authenticate to the normal error", async () => {
    const { post } = setup()
    for (let i = 0; i < 6; i++) {
      expect((await post("alice", undefined, { apikey: "bad" })).status).toBe(401)
    }
    expect((await post("alice")).status).toBe(200)
  })

  it("refuses an address that keeps failing to authenticate, before checking its key", async () => {
    const { post, refused, advance } = setup({ failures: 2 })
    for (let i = 0; i < 2; i++)
      expect((await post("anon", "198.51.100.5", { apikey: `guess_${i}` })).status).toBe(401)
    const blocked = await post("alice", "198.51.100.5")
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({
      errors: [{ extensions: { code: "CANOPY_RATE_LIMITED" } }],
    })
    expect(refused).toHaveLength(1)
    expect((await post("alice", "198.51.100.6")).status).toBe(200)
    advance(1000)
    expect((await post("alice", "198.51.100.5")).status).toBe(200)
  })

  it("lets browsers read the 429 and its Retry-After", async () => {
    const { post } = setup({ cors: true })
    const origin = { origin: "https://app.example.test" }
    for (let i = 0; i < 3; i++) await post("alice", undefined, origin)
    const response = await post("alice", undefined, origin)
    expect(response.status).toBe(429)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin.origin)
    expect(response.headers.get("access-control-expose-headers")).toBe("retry-after")
  })

  it("refuses graphql-ws operations over the budget with the same code", async () => {
    const { graphql, advance } = setup()
    const server = createServer()
    const attachment = await attachGraphqlWs(graphql, server)
    servers.push({ server, attachment })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql/v1`
    const ws = createWsClient({
      url,
      webSocketImpl: WebSocket,
      connectionParams: { apikey: PUBLISHABLE, authorization: `Bearer ${tokens.alice}` },
      retryAttempts: 0,
    })
    const run = async (): Promise<string> => {
      try {
        for await (const result of ws.iterate<{ todosCount: number }>({
          query: "{ todosCount }",
        })) {
          if (result.errors !== undefined) return JSON.stringify(result.errors)
        }
        return "ok"
      } catch (error: unknown) {
        return JSON.stringify(error)
      }
    }
    expect([await run(), await run(), await run()]).toEqual(["ok", "ok", "ok"])
    expect(await run()).toContain("CANOPY_RATE_LIMITED")
    advance(1000)
    expect(await run()).toBe("ok")
    await ws.dispose()
  })
})
