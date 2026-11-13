import { RateLimits } from "@canopy/auth"
import { allow, collection } from "@canopy/policy"
import { type ClientMessage, ErrorCode } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Keys, makeKeys, type Running, startEngine, TestClient, token } from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated"), allow.read("anon")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("realtime rate limits", () => {
  const dbName = `canopy_rt_ratelimits_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let alice: string
  let bob: string
  const engines: Running[] = []
  const clients: TestClient[] = []

  beforeAll(async () => {
    keys = await makeKeys()
    alice = await token(keys, { sub: "alice" })
    bob = await token(keys, { sub: "bob" })
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.bye()
    for (const engine of engines.splice(0)) {
      await engine.db.dropDatabase()
      await engine.stop()
    }
  })

  async function start(
    options: {
      messages?: { perSecond: number; burst: number }
      anonymous?: number
      exemptService?: boolean
      trusted?: string[]
      limited?: boolean
    } = {},
  ) {
    let now = 3_000_000
    const limits = new RateLimits({
      requests: { perSecond: 1, burst: 1 },
      messages: options.messages ?? { perSecond: 1, burst: 2 },
      anonymousConnectionsPerAddress: options.anonymous ?? 2,
      now: () => now,
      ...(options.exemptService === undefined ? {} : { exemptService: options.exemptService }),
      ...(options.trusted === undefined ? {} : { trustedProxies: options.trusted }),
    })
    const engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
      keys: { publishable: ["pk_test"], secret: ["sk_test"] },
      ...(options.limited === false ? {} : { rateLimits: limits }),
    })
    engines.push(engine)
    const connect = async (
      as: "alice" | "bob" | "anon" | "service",
      headers: Record<string, string> = {},
    ): Promise<TestClient> => {
      const client = await TestClient.connect(
        engine.url,
        as === "alice" ? alice : as === "bob" ? bob : undefined,
        as === "service" ? { key: "sk_test" } : {},
        headers,
      )
      clients.push(client)
      return client
    }
    return {
      engine,
      connect,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  const refusals = (client: TestClient) =>
    client.messages.filter(
      (m) =>
        (m.t === "nosub" && m.err?.code === ErrorCode.RateLimited) ||
        (m.t === "ack" && m.err?.code === ErrorCode.RateLimited) ||
        (m.t === "err" && m.code === ErrorCode.RateLimited),
    )

  it("answers a subscription over the budget with nosub, keeps the connection and accepts it after the refill", async () => {
    const { connect, advance, engine } = await start()
    const client = await connect("alice")
    await client.subscribe("s1", "todos")
    await client.subscribe("s2", "todos")
    expect(refusals(client)).toHaveLength(0)

    await client.subscribe("s3", "todos")
    expect(client.messages.find((m) => m.t === "nosub" && m.s === "s3")).toMatchObject({
      err: { code: ErrorCode.RateLimited },
    })
    expect(client.ready.has("s3")).toBe(false)
    expect(client.closeCode).toBeUndefined()

    client.send({ t: "ping", ts: 1 })
    await client.subscribe("s4", "todos")
    expect(client.ready.has("s4")).toBe(false)

    advance(2000)
    await client.subscribe("s5", "todos")
    expect(client.ready.has("s5")).toBe(true)
    expect(client.closeCode).toBeUndefined()
    expect(engine.realtime.metrics.rateLimited.get({ kind: "message" })).toBe(2)
  })

  it("refuses a mutation over the budget with a failed ack before running it", async () => {
    const { connect } = await start({ messages: { perSecond: 1, burst: 1 } })
    const client = await connect("alice")
    const mutate = (id: string): ClientMessage =>
      ({
        t: "mut",
        id,
        c: "todos",
        op: "insert",
        args: { doc: { _id: id } },
      }) as unknown as ClientMessage
    client.send(mutate("m1"))
    client.send(mutate("m2"))
    await client.until(() => client.messages.filter((m) => m.t === "ack").length === 2)
    const acks = client.messages.filter((m) => m.t === "ack")
    expect(acks[0]).toMatchObject({ m: "m1", ok: false, err: { code: ErrorCode.Unavailable } })
    expect(acks[1]).toMatchObject({ m: "m2", ok: false, err: { code: ErrorCode.RateLimited } })
  })

  it("answers a token refresh over the budget with an err frame and keeps the connection", async () => {
    const { connect } = await start({ messages: { perSecond: 1, burst: 1 } })
    const client = await connect("alice")
    client.send({ t: "auth", token: alice })
    client.send({ t: "auth", token: alice })
    await client.until(() => refusals(client).length === 1)
    expect(refusals(client)[0]).toMatchObject({ t: "err", code: ErrorCode.RateLimited })
    expect(client.closeCode).toBeUndefined()
  })

  it("keeps a budget per subject and does not charge pings or unsubscribes", async () => {
    const { connect } = await start({ messages: { perSecond: 1, burst: 1 } })
    const alices = await connect("alice")
    const bobs = await connect("bob")
    await alices.subscribe("s1", "todos")
    for (let i = 0; i < 10; i++) alices.send({ t: "unsub", id: "never" })
    for (let i = 0; i < 10; i++) alices.send({ t: "ping", ts: i })
    await alices.subscribe("s2", "todos")
    expect(alices.messages.find((m) => m.t === "nosub" && m.s === "s2")).toBeDefined()
    await bobs.subscribe("s1", "todos")
    expect(bobs.ready.has("s1")).toBe(true)
  })

  it("shares one budget between the connections of a subject", async () => {
    const { connect } = await start({ messages: { perSecond: 1, burst: 2 } })
    const first = await connect("alice")
    const second = await connect("alice")
    await first.subscribe("a", "todos")
    await second.subscribe("a", "todos")
    await first.subscribe("b", "todos")
    expect(first.ready.has("b")).toBe(false)
    expect(refusals(first)).toHaveLength(1)
  })

  it("exempts the service role, and charges it when the limits say so", async () => {
    const exempt = await start({ messages: { perSecond: 1, burst: 1 } })
    const service = await exempt.connect("service")
    for (let i = 0; i < 6; i++) await service.subscribe(`s${i}`, "todos")
    expect(refusals(service)).toHaveLength(0)
    await exempt.engine.db.dropDatabase()

    const strict = await start({ messages: { perSecond: 1, burst: 1 }, exemptService: false })
    const charged = await strict.connect("service")
    await charged.subscribe("s0", "todos")
    await charged.subscribe("s1", "todos")
    expect(refusals(charged)).toHaveLength(1)
  })

  it("caps anonymous connections per address, closes the extra one with 4029 and frees room on close", async () => {
    const { connect, engine } = await start({ anonymous: 2 })
    const first = await connect("anon")
    await connect("anon")
    const third = await connect("anon")
    expect(third.welcome).toBeUndefined()
    expect(third.closeCode).toBe(4029)
    expect(third.messages.find((m) => m.t === "err")).toMatchObject({
      code: ErrorCode.RateLimited,
    })
    expect(engine.realtime.metrics.rateLimited.get({ kind: "connection" })).toBe(1)

    first.bye()
    await first.until(() => first.closeCode !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await connect("anon")
    expect(again.welcome).toBeDefined()
  })

  it("does not cap signed in connections by address", async () => {
    const { connect } = await start({ anonymous: 1 })
    for (let i = 0; i < 4; i++) expect((await connect("alice")).welcome).toBeDefined()
  })

  it("resolves the address of anonymous connections through trusted proxies only", async () => {
    const trusted = await start({ anonymous: 1, trusted: ["127.0.0.0/8", "::1"] })
    const one = await trusted.connect("anon", { "x-forwarded-for": "198.51.100.1" })
    expect(one.welcome).toBeDefined()
    const sameAddress = await trusted.connect("anon", { "x-forwarded-for": "198.51.100.1" })
    expect(sameAddress.closeCode).toBe(4029)
    const other = await trusted.connect("anon", { "x-forwarded-for": "198.51.100.2" })
    expect(other.welcome).toBeDefined()

    const direct = await start({ anonymous: 1 })
    await direct.connect("anon", { "x-forwarded-for": "198.51.100.1" })
    const spoofed = await direct.connect("anon", { "x-forwarded-for": "198.51.100.2" })
    expect(spoofed.closeCode).toBe(4029)
  })

  it("limits nothing without rate limits", async () => {
    const { connect } = await start({ limited: false })
    const client = await connect("alice")
    for (let i = 0; i < 20; i++) await client.subscribe(`s${i}`, "todos")
    expect(refusals(client)).toHaveLength(0)
    for (let i = 0; i < 6; i++) expect((await connect("anon")).welcome).toBeDefined()
  })

  it("leaves in process anonymous connections, which have no address, to their transport", async () => {
    let now = 1
    const limits = new RateLimits({
      requests: { perSecond: 1, burst: 1 },
      messages: { perSecond: 1, burst: 1 },
      anonymousConnectionsPerAddress: 1,
      now: () => now,
    })
    const engine = await startEngine(MONGODB_URI ?? "", dbName, keys, [todos], {
      rateLimits: limits,
    })
    engines.push(engine)
    now += 1
    const frames: string[] = []
    const open = () => {
      const handler = engine.realtime.connect({
        send: (text) => frames.push(text),
        close: () => undefined,
        bufferedAmount: 0,
      })
      handler.message(JSON.stringify({ t: "hello", v: 1, key: "pk_test" }))
      return handler
    }
    const handlers = [open(), open(), open()]
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(frames.filter((frame) => frame.includes('"t":"welcome"'))).toHaveLength(3)
    for (const handler of handlers) {
      for (let i = 0; i < 4; i++)
        handler.message(JSON.stringify({ t: "sub", id: `s${i}`, c: "todos", q: {} }))
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(frames.some((frame) => frame.includes(ErrorCode.RateLimited))).toBe(false)
    for (const handler of handlers) handler.close()
  })
})
