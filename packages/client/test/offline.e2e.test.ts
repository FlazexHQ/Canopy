import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { encode } from "@canopy/protocol"
import { attach, createRealtime } from "@canopy/realtime"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI, TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type CanopyClient,
  type ClientOptions,
  createClient,
  type Persister,
  type StaleMutation,
} from "../src/index.ts"
import { memoryPersister } from "../src/persist.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A copy of everything a persister holds, as a second tab or a later page load would see it. */
async function snapshot(source: Persister): Promise<Persister> {
  const copy = memoryPersister()
  for (const scope of ["mutations", "docs"] as const)
    for (const [key, value] of await source.entries(scope)) await copy.set(scope, key, value)
  return copy
}

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

suite("offline queue and persistence", () => {
  const dbName = `canopy_client_off_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let url: string
  let stop: () => Promise<void>
  const tokens: Record<string, string> = {}
  const clients: CanopyClient[] = []
  const unreachable = "http://127.0.0.1:9"

  const open = (options: Partial<ClientOptions> & { user?: string } = {}): CanopyClient => {
    const { user = "alice", ...rest } = options
    const client = createClient({
      url,
      publishableKey: "pk",
      auth: { getToken: () => tokens[user] },
      maxBackoffMs: 200,
      ...rest,
    })
    clients.push(client)
    return client
  }

  const rows = () => mongo.db(dbName).collection<{ _id: number; [key: string]: unknown }>("todos")

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "EdDSA" }
    for (const user of ["alice", "bob"])
      tokens[user] = await new SignJWT({ sub: user })
        .setProtectedHeader({ alg: "EdDSA", kid: "k" })
        .setIssuer("iss")
        .setAudience("aud")
        .setExpirationTime("1h")
        .sign(privateKey)
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const set = createPolicySet([todos])
    const realtime = await createRealtime({
      engine: TEST_ENGINE,
      mongo,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      auth: { jwks: { keys: [jwk] }, issuer: "iss", audience: "aud" },
      policies: { set },
      checkpoints: "off",
      observerLingerMs: 0,
      mutations: new WritePath({
        client: mongo,
        database: dbName,
        metaDatabase: `${dbName}_meta`,
        policies: testPolicyEngine(set),
      }),
    })
    const server = createServer()
    const attachment = await attach(realtime, server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    stop = async () => {
      await realtime.close()
      await attachment.close()
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
    await rows().deleteMany({})
    await rows().insertOne({ _id: 1, ownerId: "alice", title: "one", n: 0 })
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.close()
  })

  it("queues mutations while the server is unreachable and replays them in order after a reload", async () => {
    const persist = memoryPersister()
    const offline = open({ url: unreachable, persist })
    const live = offline.from("todos").find({})
    live.subscribe(() => {})
    const first = offline.update("todos", 1, { $set: { title: "uno" } })
    void offline.update("todos", 1, { $inc: { n: 2 } })
    void offline.insert("todos", { _id: 2, ownerId: "alice", title: "two", n: 0 })
    void offline.update("todos", 2, { $set: { title: "dos" } })
    expect(offline.pendingMutations).toBe(4)
    await sleep(100)
    expect(offline.connectionStatus).not.toBe("live")
    expect((await persist.entries("mutations")).length).toBe(4)
    offline.close()
    await expect(first).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
    expect(await rows().countDocuments()).toBe(1)

    const reloaded = open({ persist })
    await until(() => reloaded.connectionStatus === "live")
    await until(() => reloaded.pendingMutations === 0)
    const stored = await rows().find().sort({ _id: 1 }).toArray()
    expect(stored).toEqual([
      { _id: 1, ownerId: "alice", title: "uno", n: 2 },
      { _id: 2, ownerId: "alice", title: "dos", n: 0 },
    ])
    await sleep(50)
    expect(await persist.entries("mutations")).toEqual([])
  })

  it("warns when a queued mutation cannot be stored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const persist = memoryPersister()
      const broken: Persister = {
        ...persist,
        set: () => Promise.reject(new Error("quota exceeded")),
      }
      const offline = open({ url: unreachable, persist: broken })
      void offline.insert("todos", { _id: 6, ownerId: "alice", title: "unsaved" })
      await until(() => warn.mock.calls.length > 0)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not store a queued mutation/)
      expect(offline.pendingMutations).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("shows restored mutations optimistically before the server confirms them", async () => {
    const persist = memoryPersister()
    const offline = open({ url: unreachable, persist })
    void offline.insert("todos", { _id: 5, ownerId: "alice", title: "queued" })
    await sleep(50)
    offline.close()
    const later = open({ url: unreachable, persist })
    await until(() => later.pendingMutations === 1)
    expect(later.store.view("todos", 5)).toMatchObject({ title: "queued" })
    expect(later.store.pendingLayers).toBe(1)
  })

  it("replays with the original mutation IDs, so a second replay of the same entries changes nothing", async () => {
    const persist = memoryPersister()
    const offline = open({ url: unreachable, persist })
    void offline.update("todos", 1, { $inc: { n: 5 } })
    await sleep(50)
    offline.close()
    const copy = await snapshot(persist)
    const tabA = open({ persist })
    await until(() => tabA.connectionStatus === "live" && tabA.pendingMutations === 0)
    const tabB = open({ persist: copy })
    await until(() => tabB.connectionStatus === "live" && tabB.pendingMutations === 0)
    expect((await rows().findOne({ _id: 1 }))?.["n"]).toBe(5)
  })

  it("keeps each user's queue to that user", async () => {
    const persist = memoryPersister()
    const offline = open({ url: unreachable, persist })
    void offline.update("todos", 1, { $set: { title: "by alice" } })
    await sleep(50)
    offline.close()
    const bob = open({ persist, user: "bob" })
    await until(() => bob.connectionStatus === "live")
    expect(bob.pendingMutations).toBe(0)
    await sleep(100)
    expect((await rows().findOne({ _id: 1 }))?.["title"]).toBe("one")
    expect((await persist.entries("mutations")).length).toBe(1)
    const alice = open({ persist })
    await until(() => alice.connectionStatus === "live" && alice.pendingMutations === 0)
    expect((await rows().findOne({ _id: 1 }))?.["title"]).toBe("by alice")
  })

  /** A token source whose user can be switched; Alice's sign in can be held so her queue is never sent. */
  const switchable = (holdAlice: boolean) => {
    let user = "alice"
    let calls = 0
    const listeners = new Set<() => void>()
    return {
      source: {
        getToken: (): string | undefined | Promise<string | undefined> => {
          calls++
          if (user === "alice" && holdAlice && calls > 1) return new Promise(() => {})
          return tokens[user]
        },
        onChange: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      switchTo(next: string) {
        user = next
        for (const listener of listeners) listener()
      },
    }
  }

  it("does not send one user's queued mutations as the next user", async () => {
    const persist = memoryPersister()
    const auth = switchable(true)
    const client = open({ persist, auth: auth.source })
    await sleep(50)
    const queued = client.insert("todos", { _id: 9, ownerId: "alice", title: "alice's" })
    await sleep(100)
    expect(client.connectionStatus).not.toBe("live")
    expect((await persist.entries("mutations")).length).toBe(1)
    auth.switchTo("bob")
    await expect(queued).rejects.toMatchObject({ code: "CANOPY_UNAUTHORIZED" })
    await until(() => client.connectionStatus === "live")
    await sleep(300)
    expect(client.pendingMutations).toBe(0)
    expect(client.store.pendingLayers).toBe(0)
    expect(await rows().countDocuments({ _id: 9 })).toBe(0)
    expect((await persist.entries("mutations")).length).toBe(1)
    void client.insert("todos", { _id: 10, ownerId: "bob", title: "bob's" })
    await until(() => client.pendingMutations === 0)
    expect((await rows().findOne({ _id: 10 }))?.["ownerId"]).toBe("bob")

    const alice = open({ persist })
    await until(() => alice.connectionStatus === "live" && alice.pendingMutations === 0)
    expect(await rows().findOne({ _id: 9 })).toEqual({
      _id: 9,
      ownerId: "alice",
      title: "alice's",
    })
    await sleep(50)
    expect(await persist.entries("mutations")).toEqual([])
  })

  it("shows the next user none of the previous user's documents once its queries are ready", async () => {
    const auth = switchable(false)
    const client = open({ auth: auth.source })
    const live = client.from("todos").find({})
    let seen: readonly unknown[] = []
    live.subscribe((state) => {
      seen = state.data
    })
    await until(() => seen.length === 1)
    auth.switchTo("bob")
    await until(() => client.connectionStatus === "live" && seen.length === 0)
    await sleep(200)
    expect(seen).toEqual([])
  })

  it("holds back mutations older than the idempotency window and lets the app retry or discard them", async () => {
    const persist = memoryPersister()
    const old = Date.now() - 21 * 3_600_000
    const record = (id: string, update: Record<string, unknown>) =>
      JSON.stringify(
        encode({
          m: { t: "mut", id, c: "todos", op: "update", args: { id: 1, update } },
          ids: [1],
          layers: [{ kind: "update", coll: "todos", id: 1, update }],
          at: old,
        }),
      )
    const retried = "0192f6a1-7c2e-7b1a-9d3e-00000000b001"
    const dropped = "0192f6a1-7c2e-7b1a-9d3e-00000000b002"
    await persist.set("mutations", `alice\u0000${retried}`, record(retried, { $inc: { n: 1 } }))
    await persist.set("mutations", `alice\u0000${dropped}`, record(dropped, { $inc: { n: 100 } }))
    const client = open({ persist })
    const reported: (readonly StaleMutation[])[] = []
    client.onStaleMutations((mutations) => reported.push(mutations))
    await until(() => reported.length > 0 && client.connectionStatus === "live")
    expect(client.pendingMutations).toBe(0)
    const stale = reported[0] ?? []
    expect(stale.map((entry) => entry.mutationId)).toEqual([retried, dropped])
    expect(stale[0]).toMatchObject({ collection: "todos", op: "update", createdAt: old })
    await sleep(100)
    expect((await rows().findOne({ _id: 1 }))?.["n"]).toBe(0)
    const handle = stale[0]?.retry()
    expect(handle?.mutationId).not.toBe(retried)
    await handle
    expect(client.staleMutations.map((entry) => entry.mutationId)).toEqual([dropped])
    stale[1]?.discard()
    expect(client.staleMutations).toEqual([])
    expect(reported.slice(1).map((list) => list.map((entry) => entry.mutationId))).toEqual([
      [dropped],
      [],
    ])
    expect((await rows().findOne({ _id: 1 }))?.["n"]).toBe(1)
    await sleep(50)
    expect(await persist.entries("mutations")).toEqual([])
    const late: (readonly StaleMutation[])[] = []
    client.onStaleMutations((mutations) => late.push(mutations))
    expect(late).toEqual([])
  })

  it("replays a mutation just inside the window", async () => {
    const persist = memoryPersister()
    const id = "0192f6a1-7c2e-7b1a-9d3e-00000000c001"
    await persist.set(
      "mutations",
      `alice\u0000${id}`,
      JSON.stringify(
        encode({
          m: {
            t: "mut",
            id,
            c: "todos",
            op: "update",
            args: { id: 1, update: { $inc: { n: 3 } } },
          },
          ids: [1],
          layers: [],
          at: Date.now() - 19 * 3_600_000,
        }),
      ),
    )
    const client = open({ persist })
    const reported: unknown[] = []
    client.onStaleMutations((mutations) => reported.push(mutations))
    await until(() => client.connectionStatus === "live" && client.pendingMutations === 0)
    expect(reported).toEqual([])
    expect((await rows().findOne({ _id: 1 }))?.["n"]).toBe(3)
  })

  it("starts from the document cache, stale, and reconciles with the server", async () => {
    const persist = memoryPersister()
    const first = open({ persist, cacheDocuments: true })
    const live = first.from("todos").find({}).sort({ _id: 1 })
    live.subscribe(() => {})
    await until(() => live.getState().status === "ready")
    await rows().insertOne({ _id: 3, ownerId: "alice", title: "three", n: 0 })
    await until(() => live.getState().data.length === 2)
    await sleep(700)
    first.close()

    const offline = open({ url: unreachable, persist, cacheDocuments: true })
    const cached = offline.from("todos").find({}).sort({ _id: 1 })
    cached.subscribe(() => {})
    await until(() => cached.getState().data.length === 2)
    expect(cached.getState().status).toBe("stale")
    expect(cached.getState().data.map((doc) => doc["title"])).toEqual(["one", "three"])
    expect(offline.from("todos").find({ done: true }).getState().data).toEqual([])
    offline.close()

    await rows().deleteOne({ _id: 3 })
    await rows().updateOne({ _id: 1 }, { $set: { title: "uno" } })
    const online = open({ persist, cacheDocuments: true })
    const fresh = online.from("todos").find({}).sort({ _id: 1 })
    const seen: string[][] = []
    fresh.subscribe((state) => seen.push(state.data.map((doc) => String(doc["title"]))))
    await until(() => fresh.getState().status === "ready")
    expect(fresh.getState().data.map((doc) => doc["title"])).toEqual(["uno"])
    expect(seen).toContainEqual(["one", "three"])
    const shown = seen.findIndex((titles) => titles.length > 0)
    expect(shown).toBeGreaterThanOrEqual(0)
    expect(seen.slice(shown).some((titles) => titles.length === 0)).toBe(false)

    const bob = open({ url: unreachable, persist, cacheDocuments: true, user: "bob" })
    const theirs = bob.from("todos").find({}).sort({ _id: 1 })
    theirs.subscribe(() => {})
    await sleep(100)
    expect(theirs.getState()).toMatchObject({ status: "loading", data: [] })
  })
})
