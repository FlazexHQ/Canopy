import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { attach, createRealtime } from "@canopy/realtime"
import { WritePath } from "@canopy/rest"
import { MONGODB_URI, TEST_ENGINE, testPolicyEngine } from "@canopy/testing"
import {
  type CanopyClient,
  ConflictError,
  createClient,
  ObjectId,
  PolicyViolationError,
  type QueryState,
} from "canopy.js"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Document, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

const suite = MONGODB_URI === undefined ? describe.skip : describe

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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

suite("optimistic mutations against the realtime engine", () => {
  const dbName = `canopy_client_mut_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let url: string
  let stop: () => Promise<void>
  let token: string
  const clients: CanopyClient[] = []

  const open = (): CanopyClient => {
    const client = createClient({ url, publishableKey: "pk", auth: { getToken: () => token } })
    clients.push(client)
    return client
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
    await mongo.db(dbName).collection("todos").deleteMany({})
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.close()
  })

  /** Subscribes and records every state a UI would render. */
  const watch = async (client: CanopyClient, filter: Document) => {
    const states: QueryState[] = []
    const live = client.from("todos").find(filter).sort({ n: 1 })
    const unsubscribe = live.subscribe((state) => states.push(state))
    await until(() => live.getState().status === "ready")
    const titles = (state: QueryState = live.getState()) => state.data.map((doc) => doc["title"])
    return { live, states, unsubscribe, titles }
  }

  it("shows an insert at once, confirms it by echo and never flickers", async () => {
    const client = open()
    const view = await watch(client, { done: false })
    const handle = client
      .from("todos")
      .insert({ title: "ship", ownerId: "alice", done: false, n: 1 })
    expect(handle.id).toBeInstanceOf(ObjectId)
    expect(view.titles()).toEqual(["ship"])
    const result = await handle
    expect(result).toMatchObject({ echo: true, replayed: false })
    expect(client.pendingMutations).toBe(0)
    const shown = view.states.map((state) => view.titles(state).includes("ship"))
    const first = shown.indexOf(true)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(shown.slice(first).every(Boolean)).toBe(true)
    expect(view.titles()).toEqual(["ship"])
    const stored = await mongo.db(dbName).collection("todos").findOne({ title: "ship" })
    expect(String(stored?.["_id"])).toBe((handle.id as ObjectId).hex)
  })

  it("moves a document between queries before the server answers", async () => {
    const client = open()
    const open1 = await watch(client, { done: false })
    const done = await watch(client, { done: true })
    const created = await client.insert("todos", {
      _id: 1,
      title: "a",
      ownerId: "alice",
      done: false,
      n: 1,
    })
    expect(created.echo).toBe(true)
    const update = client.update("todos", 1, { $set: { done: true } })
    expect(open1.titles()).toEqual([])
    expect(done.titles()).toEqual(["a"])
    await update
    expect(open1.titles()).toEqual([])
    expect(done.titles()).toEqual(["a"])
    expect(
      done.states
        .slice(done.states.findIndex((s) => done.titles(s).length > 0))
        .every((s) => done.titles(s).length === 1),
    ).toBe(true)
  })

  it("rolls back a rejected insert and rejects the handle with a typed error", async () => {
    const client = open()
    const view = await watch(client, {})
    const errors: unknown[] = []
    client.onMutationError((error) => errors.push(error))
    const handle = client.insert("todos", { title: "theirs", ownerId: "bob", n: 1 })
    expect(view.titles()).toEqual(["theirs"])
    await expect(handle).rejects.toBeInstanceOf(PolicyViolationError)
    await until(() => view.titles().length === 0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(PolicyViolationError)
    expect(await mongo.db(dbName).collection("todos").countDocuments()).toBe(0)
  })

  it("rolls back a failed compare and set to the server state", async () => {
    const client = open()
    const view = await watch(client, {})
    await client.insert("todos", { _id: 2, title: "v1", ownerId: "alice", n: 1 })
    const handle = client.update("todos", 2, { $set: { title: "v2" } }, { where: { title: "v0" } })
    expect(view.titles()).toEqual(["v2"])
    await expect(handle).rejects.toBeInstanceOf(ConflictError)
    expect(view.titles()).toEqual(["v1"])
  })

  it("rebases a pending increment on a concurrent server change", async () => {
    const client = open()
    const view = await watch(client, {})
    await client.insert("todos", { _id: 3, title: "c", ownerId: "alice", n: 10 })
    const handle = client.update("todos", 3, { $inc: { n: 1 } })
    await mongo
      .db(dbName)
      .collection<{ _id: number; n?: number }>("todos")
      .updateOne({ _id: 3 }, { $inc: { n: 100 } })
    await handle
    await until(() => view.live.getState().data[0]?.["n"] === 111)
    expect(
      (
        await mongo.db(dbName).collection<{ _id: number; n?: number }>("todos").findOne({ _id: 3 })
      )?.["n"],
    ).toBe(111)
  })

  it("queues mutations made before the connection is up and sends them in order", async () => {
    const client = open()
    const first = client.insert("todos", { _id: 4, title: "q", ownerId: "alice", n: 0 })
    const second = client.update("todos", 4, { $inc: { n: 5 } })
    const third = client.delete("todos", 4)
    expect(client.pendingMutations).toBe(3)
    await Promise.all([first, second, third])
    expect(await mongo.db(dbName).collection("todos").countDocuments()).toBe(0)
  })

  it("applies bulk writes optimistically and settles them from server state", async () => {
    const client = open()
    const view = await watch(client, { done: false })
    await client.insertMany("todos", [
      { _id: 5, title: "x", ownerId: "alice", done: false, n: 1 },
      { _id: 6, title: "y", ownerId: "alice", done: false, n: 2 },
    ])
    expect(view.titles()).toEqual(["x", "y"])
    const bulk = client.updateMany("todos", { done: false }, { $set: { done: true } })
    expect(view.titles()).toEqual([])
    const result = await bulk
    expect(result).toMatchObject({ echo: false, matched: 2, modified: 2 })
    await until(() => client.store.pendingLayers === 0)
    expect(view.titles()).toEqual([])
  })

  it("rejects pending mutations when the client closes", async () => {
    const client = open()
    const handle = client.insert("todos", { title: "late", ownerId: "alice" })
    client.close()
    await expect(handle).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
  })
})
