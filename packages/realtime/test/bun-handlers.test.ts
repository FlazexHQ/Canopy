import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { CloseCode, type SequencedMessage, SUBPROTOCOL } from "@canopy/protocol"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI, TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { bunHandlers, createRealtime, type Realtime } from "../src/index.ts"
import { type Keys, makeKeys, sleep, TestClient, token } from "./harness.ts"

interface BunServer {
  readonly port: number
  stop(force?: boolean): void
}

interface BunRuntime {
  serve(options: { port: number; hostname: string; fetch: unknown; websocket: unknown }): BunServer
}

const bun = (globalThis as { Bun?: BunRuntime }).Bun

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined || bun === undefined ? describe.skip : describe

type Ack = Extract<SequencedMessage, { t: "ack" }>

suite("bunHandlers on Bun.serve (run with bun --bun vitest)", () => {
  const uri = MONGODB_URI ?? ""
  const dbName = `canopy_rt_bun_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let mongo: MongoClient
  let realtime: Realtime
  let server: BunServer
  let url: string
  let http: string
  let alice: string
  const clients: TestClient[] = []

  beforeAll(async () => {
    keys = await makeKeys()
    mongo = new MongoClient(uri)
    await mongo.connect()
    const policies = [todos]
    realtime = await createRealtime({
      engine: TEST_ENGINE,
      mongo,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      auth: {
        jwks: { keys: [keys.jwk] },
        issuer: "https://issuer.test/",
        audience: "https://api.test",
        rolesClaim: "roles",
      },
      keys: { publishable: ["pk_test"] },
      policies: { set: createPolicySet(policies) },
      checkpoints: "off",
      observerLingerMs: 0,
      echoTimeoutMs: 3000,
      mutations: new WritePath({
        client: mongo,
        database: dbName,
        metaDatabase: `${dbName}_meta`,
        policies: testPolicyEngine(createPolicySet(policies)),
      }),
    })
    const handlers = bunHandlers(realtime, {
      fallback: () => new Response("fallback", { status: 202 }),
    })
    server = (bun as BunRuntime).serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: handlers.fetch,
      websocket: handlers.websocket,
    })
    url = `ws://127.0.0.1:${server.port}/realtime/v1`
    http = `http://127.0.0.1:${server.port}`
    alice = await token(keys, { sub: "alice" })
  })

  afterAll(async () => {
    for (const client of clients.splice(0)) client.bye()
    server?.stop(true)
    await realtime?.close()
    await mongo?.db(dbName).dropDatabase()
    await mongo?.db(`${dbName}_meta`).dropDatabase()
    await mongo?.close()
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  const connect = async (resume?: { sid: string; seq: number }): Promise<TestClient> => {
    const client = await TestClient.connect(url, alice, resume === undefined ? {} : { resume })
    clients.push(client)
    return client
  }

  it("subscribes, mutates with echo before ack, and resumes the session", async () => {
    const client = await connect()
    expect(client.welcome?.resumed).toBe(false)
    await client.subscribe("s", "todos")
    const id = "0192f6a1-7c2e-7b1a-9d3e-000000000001"
    client.send({
      t: "mut",
      id,
      c: "todos",
      op: "insert",
      args: { doc: { _id: 1, ownerId: "alice", title: "from bun" } },
    } as never)
    await client.until(() => client.messages.some((m) => m.t === "ack" && m.m === id))
    const ack = client.messages.find((m): m is Ack => m.t === "ack" && m.m === id) as Ack
    expect(ack).toMatchObject({ ok: true, echo: true })
    const added = client.messages.find((m) => m.t === "added")
    expect(added?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(ack.seq)
    expect(client.ids("s")).toEqual([1])

    const sid = client.welcome?.sid ?? ""
    const seq = client.lastSeq
    client.terminate()
    await sleep(100)
    await mongo
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: 2 as never, ownerId: "alice", title: "while away" })
    await sleep(300)
    const resumed = await connect({ sid, seq })
    expect(resumed.welcome).toMatchObject({ resumed: true, sid })
    await resumed.until(() => resumed.messages.some((m) => m.t === "added"))
    const replayed = resumed.messages.filter((m) => m.t !== "welcome")
    expect(replayed[0]?.seq).toBe(seq + 1)
    expect(replayed.map((m) => m.seq)).toEqual(replayed.map((_, index) => seq + 1 + index))
  })

  it("refuses an upgrade without the Canopy subprotocol and a binary frame", async () => {
    const response = await fetch(`${http}/realtime/v1`, {
      headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13" },
    })
    expect(response.status).toBe(426)
    const socket = new WebSocket(url, SUBPROTOCOL)
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    socket.send(Buffer.from([1, 2, 3]))
    expect(await closed).toBe(CloseCode.ProtocolError)
  })

  it("serves other paths from the fallback", async () => {
    expect((await fetch(`${http}/elsewhere`)).status).toBe(202)
  })
})
