import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import {
  Authenticator,
  attach,
  createHttpTransport,
  createRealtime,
  toNodeHandler,
} from "@canopy/realtime"
import { createRestHandler, toNodeListener } from "@canopy/rest"
import { MONGODB_URI, TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { longPoll, sse, transports } from "../src/fallback.ts"
import {
  type CanopyClient,
  type ClientOptions,
  type ConnectionStatus,
  createClient,
  PolicyViolationError,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../src/index.ts"
import { restPolling } from "../src/rest-polling.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A WebSocket whose handshake always fails, as behind a proxy that drops upgrades. */
class BlockedWebSocket implements WebSocketLike {
  static attempts = 0
  readyState = 0
  readonly protocol = ""
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor() {
    BlockedWebSocket.attempts += 1
    setTimeout(() => {
      this.readyState = 3
      this.onerror?.({})
      this.onclose?.({ code: 1006, reason: "" })
    }, 5)
  }

  send(): void {}
  close(): void {}
}

const Blocked = BlockedWebSocket as unknown as WebSocketConstructor

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})

suite("fallback transports and fallback syncing", () => {
  const dbName = `canopy_client_fb_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let url: string
  let token: string
  let stop: () => Promise<void>
  const statuses: number[] = []
  const clients: CanopyClient[] = []

  const countingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    if (String(input instanceof Request ? input.url : input).includes("/rest/v1/todos"))
      statuses.push(response.status)
    return response
  }

  const open = (options: Partial<ClientOptions>): CanopyClient => {
    const client = createClient({
      url,
      publishableKey: "pk",
      auth: { getToken: () => token },
      fetch: countingFetch,
      ...options,
    })
    clients.push(client)
    return client
  }

  const watch = async (client: CanopyClient) => {
    const live = client.from("todos").find({}).sort({ n: 1 })
    const unsubscribe = live.subscribe(() => {})
    await until(() => live.getState().data.length > 0 || live.getState().status !== "loading")
    const titles = () => live.getState().data.map((doc) => doc["title"])
    return { live, unsubscribe, titles }
  }

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "EdDSA" }
    token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k" })
      .setIssuer("iss")
      .setAudience("aud")
      .setExpirationTime("1h")
      .sign(privateKey)
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const jwt = { jwks: { keys: [jwk] }, issuer: "iss", audience: "aud" }
    const set = createPolicySet([todos])
    const rest = createRestHandler({
      client: mongo,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: testPolicyEngine(set),
      authenticator: new Authenticator(jwt, { publishable: ["pk"] }),
    })
    const realtime = await createRealtime({
      engine: TEST_ENGINE,
      mongo,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      auth: jwt,
      keys: { publishable: ["pk"] },
      policies: { set },
      checkpoints: "off",
      observerLingerMs: 0,
      mutations: rest.writes,
    })
    const http = createHttpTransport(realtime)
    const fallbackHandler = toNodeHandler(http)
    const restListener = toNodeListener(rest)
    const server = createServer((request, response) => {
      if ((request.url ?? "").startsWith("/rest/v1")) restListener(request, response)
      else fallbackHandler(request, response)
    })
    const attachment = await attach(realtime, server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    stop = async () => {
      http.close()
      await realtime.close()
      await attachment.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  afterAll(async () => {
    await stop()
    await mongo.db(dbName).dropDatabase()
    await mongo.db(`${dbName}_meta`).dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    BlockedWebSocket.attempts = 0
    statuses.length = 0
    await mongo.db(dbName).collection("todos").deleteMany({})
    await mongo
      .db(dbName)
      .collection("todos")
      .insertMany([
        { _id: 1 as never, title: "one", ownerId: "alice", n: 1 },
        { _id: 2 as never, title: "theirs", ownerId: "bob", n: 2 },
      ])
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.close()
  })

  it("moves to SSE after two failed WebSocket handshakes and keeps queries and mutations live", async () => {
    let loads = 0
    const seen: ConnectionStatus[] = []
    const client = open({
      WebSocket: Blocked,
      fallback: async () => {
        loads += 1
        return { transports }
      },
    })
    client.onStatus((status) => seen.push(status))
    const view = await watch(client)
    await until(() => view.live.getState().status === "ready")
    expect(client.connectionStatus).toBe("fallback")
    expect(BlockedWebSocket.attempts).toBe(2)
    expect(loads).toBe(1)
    expect(seen.at(-1)).toBe("fallback")
    expect(view.titles()).toEqual(["one"])
    await mongo
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: 3 as never, title: "three", ownerId: "alice", n: 3 })
    await until(() => view.titles().length === 2)
    expect(view.titles()).toEqual(["one", "three"])
    const handle = client.insert("todos", { _id: 4, title: "four", ownerId: "alice", n: 4 })
    expect(view.titles()).toEqual(["one", "three", "four"])
    expect(await handle).toMatchObject({ echo: true, replayed: false })
    const rejected = client.insert("todos", { _id: 5, title: "bad", ownerId: "bob", n: 5 })
    await expect(rejected).rejects.toBeInstanceOf(PolicyViolationError)
    expect(view.titles()).toEqual(["one", "three", "four"])
    expect(statuses).toEqual([])
  })

  it("works over long-polling without any WebSocket attempts beyond the failed ones", async () => {
    const client = open({ WebSocket: Blocked, fallback: { transports: [longPoll] } })
    const view = await watch(client)
    await until(() => view.live.getState().status === "ready")
    expect(client.connectionStatus).toBe("fallback")
    expect(view.titles()).toEqual(["one"])
    await mongo
      .db(dbName)
      .collection("todos")
      .updateOne({ _id: 1 as never }, { $set: { title: "uno" } })
    await until(() => view.titles()[0] === "uno")
    await client.update("todos", 1, { $set: { title: "eins" } })
    expect(view.titles()).toEqual(["eins"])
    const stored = await mongo
      .db(dbName)
      .collection("todos")
      .findOne({ _id: 1 as never })
    expect(stored?.["title"]).toBe("eins")
  })

  it("keeps the session across a broken SSE stream by resuming it", async () => {
    let socket: WebSocketLike | undefined
    const tracking = {
      transports: [
        {
          connect: (base: string, fetchImpl: typeof fetch) => {
            socket = sse.connect(base, fetchImpl)
            return socket
          },
        },
      ],
    }
    const client = open({ WebSocket: Blocked, fallback: tracking })
    const view = await watch(client)
    await until(() => view.live.getState().status === "ready")
    const first = socket
    first?.close(4000, "simulated network drop")
    await until(() => socket !== first && client.connectionStatus === "fallback")
    await mongo
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: 6 as never, title: "six", ownerId: "alice", n: 6 })
    await until(() => view.titles().includes("six"))
    expect(view.titles()).toEqual(["one", "six"])
  })

  it("probes WebSocket while on a fallback and moves back up when it works", async () => {
    let blocked = true
    const Switchable = function (this: unknown, target: string, protocols?: string | string[]) {
      return blocked ? new BlockedWebSocket() : new WebSocket(target, protocols)
    } as unknown as WebSocketConstructor
    const client = open({ WebSocket: Switchable, fallback: { transports }, probeIntervalMs: 200 })
    const view = await watch(client)
    await until(
      () => client.connectionStatus === "fallback" && view.live.getState().status === "ready",
    )
    blocked = false
    await until(() => client.connectionStatus === "live")
    await mongo
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: 7 as never, title: "seven", ownerId: "alice", n: 7 })
    await until(() => view.titles().includes("seven"))
    expect(view.titles()).toEqual(["one", "seven"])
    expect(view.live.getState().status).toBe("ready")
  })

  it("never loads the fallback transports while WebSockets work", async () => {
    let loads = 0
    const client = open({
      fallback: async () => {
        loads += 1
        return { transports }
      },
    })
    const view = await watch(client)
    await until(() => view.live.getState().status === "ready")
    expect(client.connectionStatus).toBe("live")
    expect(loads).toBe(0)
  })

  it("polls over REST when realtime is unreachable, with stale queries and conditional requests", async () => {
    const client = open({
      WebSocket: Blocked,
      fallback: { transports: [restPolling({ intervalMs: 150 })] },
    })
    const view = await watch(client)
    await until(() => view.titles().length === 1)
    expect(client.connectionStatus).toBe("fallback")
    expect(view.live.getState().status).toBe("stale")
    expect(view.titles()).toEqual(["one"])
    await until(() => statuses.includes(304))
    expect(statuses[0]).toBe(200)
    await mongo
      .db(dbName)
      .collection("todos")
      .insertOne({ _id: 8 as never, title: "eight", ownerId: "alice", n: 8 })
    await until(() => view.titles().length === 2)
    await mongo
      .db(dbName)
      .collection("todos")
      .deleteOne({ _id: 1 as never })
    await until(() => view.titles().length === 1)
    expect(view.titles()).toEqual(["eight"])
    const handle = client.insert("todos", { _id: 9, title: "nine", ownerId: "alice", n: 9 })
    expect(view.titles()).toEqual(["eight", "nine"])
    expect(await handle).toMatchObject({ echo: false, insertedIds: [9] })
    expect(view.titles()).toEqual(["eight", "nine"])
    const again = await client.update("todos", 9, { $inc: { n: 1 } })
    expect(again).toMatchObject({ matched: 1 })
    await expect(
      client.insert("todos", { _id: 10, title: "bad", ownerId: "bob", n: 10 }),
    ).rejects.toBeInstanceOf(PolicyViolationError)
    await client.delete("todos", 8)
    expect(view.titles()).toEqual(["nine"])
    const stored = await mongo.db(dbName).collection("todos").find().sort({ _id: 1 }).toArray()
    expect(stored.map((doc) => doc["_id"])).toEqual([2, 9])
    expect(stored[1]?.["n"]).toBe(10)
  })
})
