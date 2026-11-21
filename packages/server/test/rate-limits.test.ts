import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { RateLimitsInput } from "@canopy/config"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.limits.test/"
const AUDIENCE = "https://api.limits.test"
const KEY = "pk_limits_test"
const SECRET = "sk_limits_test"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") }), allow.read("anon")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("rate limits of createCanopy against MongoDB", () => {
  const dbName = `canopy_server_limits_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let jwk: Record<string, unknown>
  let sign: (sub: string) => Promise<string>
  const running: { canopy: Canopy; server: Server }[] = []

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    sign = (sub) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
  })

  afterEach(async () => {
    for (const { canopy, server } of running.splice(0)) {
      await canopy.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    const mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    await mongo.db(dbName).dropDatabase()
    await mongo.db(metaName).dropDatabase()
    await mongo.close()
  })

  async function start(rateLimits?: boolean | RateLimitsInput, proxies: string[] = []) {
    const canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
        keys: { publishable: [KEY], secret: [SECRET] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        server: { trustedProxies: proxies },
        ...(rateLimits === undefined ? {} : { rateLimits }),
      }),
      { env: TEST_ENV, policies: createPolicySet([notes]), onSetupToken: false },
    )
    const server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    running.push({ canopy, server })
    return { canopy, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }

  const statuses = async (count: number, request: () => Promise<Response>): Promise<number[]> => {
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push((await request()).status)
    return out
  }

  it("answers 429 with Retry-After over REST and GraphQL from the configured budget", async () => {
    const { base } = await start({ requests: { perSecond: 1, burst: 2 } })
    const token = await sign("alice")
    const rest = () =>
      fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY, authorization: `Bearer ${token}` } })
    const first = await statuses(2, rest)
    expect(first).toEqual([200, 200])
    const limited = await rest()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect(await limited.json()).toMatchObject({ status: 429, code: "CANOPY_RATE_LIMITED" })

    const graphql = await fetch(`${base}/graphql/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: KEY,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: "{ notesCount }" }),
    })
    expect(graphql.status).toBe(429)
    expect(graphql.headers.get("retry-after")).not.toBeNull()
  }, 20_000)

  it("lets the secret key through and counts refusals in the metrics", async () => {
    const { base, canopy } = await start({ requests: { perSecond: 1, burst: 1 } })
    const token = await sign("alice")
    const alice = () =>
      fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY, authorization: `Bearer ${token}` } })
    const service = () => fetch(`${base}/rest/v1/notes`, { headers: { apikey: SECRET } })
    expect(await statuses(10, service)).toEqual(Array.from({ length: 10 }, () => 200))
    await alice()
    await alice()
    await alice()
    const metrics = canopy.renderMetrics()
    expect(metrics).toMatch(/canopy_http_rate_limited_total\{surface="rest"\} [1-9]/)
  }, 20_000)

  it("limits anonymous callers by the address behind a trusted proxy", async () => {
    const { base } = await start({ requests: { perSecond: 1, burst: 2 } }, ["127.0.0.0/8", "::1"])
    const anon = (address: string) => () =>
      fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY, "x-forwarded-for": address } })
    const a = anon("203.0.113.5")
    expect(await statuses(2, a)).toEqual([200, 200])
    expect((await a()).status).toBe(429)
    expect((await anon("203.0.113.6")()).status).toBe(200)
  }, 20_000)

  it("caps anonymous WebSocket connections per address with close code 4029", async () => {
    const { base } = await start({ anonymousConnectionsPerAddress: 1 })
    const open = async (): Promise<{ socket: WebSocket; code: Promise<number> }> => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
      const code = new Promise<number>((resolve) => socket.on("close", resolve))
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve())
        socket.once("error", reject)
      })
      socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY }))
      return { socket, code }
    }
    const first = await open()
    await new Promise<void>((resolve) => first.socket.once("message", () => resolve()))
    const second = await open()
    expect(await second.code).toBe(4029)
    first.socket.close()
  }, 20_000)

  it("serves everything when the limits are off", async () => {
    const { base } = await start(false)
    const token = await sign("alice")
    const rest = () =>
      fetch(`${base}/rest/v1/notes`, { headers: { apikey: KEY, authorization: `Bearer ${token}` } })
    expect(await statuses(40, rest)).toEqual(Array.from({ length: 40 }, () => 200))
  }, 20_000)
})
