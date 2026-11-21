import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { TEST_ENV } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type CanopyClient,
  createClient,
  type DocumentSchema,
  type QueryState,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../src/index.ts"

/** A mongos of a sharded cluster with two shards, such as `deploy/compose/sharded.yaml` starts. */
const SHARDED_URI = process.env["CANOPY_TEST_SHARDED_URI"]
const suite = SHARDED_URI === undefined ? describe.skip : describe
const KEY = "pk_sharded"
const ISSUER = "https://idp.sharded.test/"
const AUDIENCE = "https://api.sharded.test"

interface Order {
  _id: string
  tenantId: string
  ownerId: string
  total: number
}

type Db = DocumentSchema<{ orders: Order }>

const orders = collection("orders", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
  ],
})

const sockets: WebSocketLike[] = []
const Tracked = class extends (globalThis as unknown as { WebSocket: WebSocketConstructor })
  .WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols)
    sockets.push(this)
  }
} as WebSocketConstructor

async function until(test: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Canopy on a sharded cluster: the orders collection is range sharded on `tenantId` and split at "m", with
 * the upper chunk moved to the second shard, so tenants a to l live on one shard and m to z on the other.
 */
suite("Canopy on a sharded cluster", () => {
  const name = `canopy_sharded_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const namespace = `${name}.orders`
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let url: string
  const tokens = new Map<string, string>()
  const clients: CanopyClient<Db>[] = []

  const connect = (sub: string): CanopyClient<Db> => {
    const client = createClient<Db>({
      url,
      publishableKey: KEY,
      auth: { getToken: () => tokens.get(sub) },
      WebSocket: Tracked,
    })
    clients.push(client)
    return client
  }

  const live = (client: CanopyClient<Db>) => {
    const state: { current: QueryState<Order> | undefined } = { current: undefined }
    const stop = client.live("orders", {}).subscribe((next) => {
      state.current = next
    })
    return { state, stop }
  }

  const ids = (state: QueryState<Order> | undefined): string[] =>
    (state?.data ?? []).map((order) => order._id).sort()

  /** The number of orders on each shard, read through mongos. */
  const placement = async (): Promise<Record<string, number>> => {
    const stats = await mongo
      .db(name)
      .collection("orders")
      .aggregate<{ shard: string; count: number }>([{ $collStats: { count: {} } }])
      .toArray()
    return Object.fromEntries(stats.map((stat) => [stat.shard, stat.count]))
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }
    for (const sub of ["alice", "bob"])
      tokens.set(
        sub,
        await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject(sub)
          .setExpirationTime("10m")
          .sign(pair.privateKey),
      )
    mongo = new MongoClient(SHARDED_URI ?? "")
    await mongo.connect()
    const admin = mongo.db("admin")
    const shards = (await admin.command({ listShards: 1 }))["shards"] as { _id: string }[]
    expect(shards.length).toBeGreaterThanOrEqual(2)
    await admin.command({ enableSharding: name })
    await admin.command({ shardCollection: namespace, key: { tenantId: 1 } })
    await admin.command({ split: namespace, middle: { tenantId: "m" } })
    const database = await mongo
      .db("config")
      .collection<{ _id: string; primary: string }>("databases")
      .findOne({ _id: name })
    const target = shards.find((shard) => shard._id !== database?.primary)?._id
    if (target === undefined) throw new Error("no second shard to move the upper chunk to")
    await admin.command({ moveChunk: namespace, find: { tenantId: "z" }, to: target })
    await mongo
      .db(name)
      .collection<Order>("orders")
      .insertMany([
        { _id: "a1", tenantId: "acme", ownerId: "alice", total: 1 },
        { _id: "a2", tenantId: "zeta", ownerId: "alice", total: 2 },
        { _id: "b1", tenantId: "beta", ownerId: "bob", total: 3 },
        { _id: "b2", tenantId: "yolo", ownerId: "bob", total: 4 },
      ])
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: SHARDED_URI ?? "", database: name, metaDatabase: `${name}_meta` },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s", echoTimeout: "30s" },
        rateLimits: false,
      }),
      { env: TEST_ENV, policies: createPolicySet([orders]), onSetupToken: false },
    )
    server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 120_000)

  afterAll(async () => {
    for (const client of clients) client.close()
    await canopy?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await mongo?.db(name).dropDatabase()
    await mongo?.db(`${name}_meta`).dropDatabase()
    await mongo?.close()
  })

  it("stores the orders on both shards", async () => {
    const counts = Object.values(await placement())
    expect(counts.length).toBe(2)
    expect(counts.every((count) => count === 2)).toBe(true)
  })

  it("reads a snapshot that spans both shards, under the caller's policies", async () => {
    const alice = live(connect("alice"))
    const bob = live(connect("bob"))
    await until(
      () => alice.state.current?.status === "ready" && bob.state.current?.status === "ready",
    )
    expect(ids(alice.state.current)).toEqual(["a1", "a2"])
    expect(ids(bob.state.current)).toEqual(["b1", "b2"])
    alice.stop()
    bob.stop()
  })

  it("delivers changes from both shards and resumes them after a dropped connection", async () => {
    const client = connect("alice")
    const query = live(client)
    await until(() => query.state.current?.status === "ready")
    const documents = mongo.db(name).collection<Order>("orders")
    await documents.insertMany([
      { _id: "a3", tenantId: "alpha", ownerId: "alice", total: 5 },
      { _id: "a4", tenantId: "omega", ownerId: "alice", total: 6 },
    ])
    await until(() => ids(query.state.current).length === 4)
    expect(ids(query.state.current)).toEqual(["a1", "a2", "a3", "a4"])

    sockets.at(-1)?.close(4500, "simulated failure")
    await until(() => client.connectionStatus === "reconnecting")
    await documents.updateOne({ _id: "a1" }, { $set: { total: 10 } })
    await documents.updateOne({ _id: "a2" }, { $set: { total: 20 } })
    await documents.deleteOne({ _id: "a3" })
    await until(
      () =>
        client.connectionStatus === "live" &&
        query.state.current?.status === "ready" &&
        ids(query.state.current).length === 3,
    )
    const totals = Object.fromEntries(
      (query.state.current?.data ?? []).map((order) => [order._id, order.total]),
    )
    expect(totals).toEqual({ a1: 10, a2: 20, a4: 6 })
    query.stop()
  })

  it("acknowledges writes on either shard after their change events, and a write that spans both", async () => {
    const client = connect("alice")
    const query = live(client)
    await until(() => query.state.current?.status === "ready")
    const lowShard = await client.insert("orders", {
      _id: "w1",
      tenantId: "gamma",
      ownerId: "alice",
      total: 7,
    })
    const highShard = await client.insert("orders", {
      _id: "w2",
      tenantId: "sigma",
      ownerId: "alice",
      total: 8,
    })
    expect(lowShard, "write to the lower shard").toMatchObject({
      echo: true,
      ct: expect.any(String),
    })
    expect(highShard, "write to the upper shard").toMatchObject({
      echo: true,
      ct: expect.any(String),
    })
    expect(ids(query.state.current)).toContain("w1")
    expect(ids(query.state.current)).toContain("w2")

    const visible = ids(query.state.current).length
    const both = await client.updateMany("orders", { ownerId: "alice" }, { $inc: { total: 100 } })
    expect(both).toMatchObject({ matched: visible, modified: visible, echo: false })
    await until(() => (query.state.current?.data ?? []).every((order) => order.total > 100))
    const stored = await mongo
      .db(name)
      .collection<Order>("orders")
      .find({ ownerId: "bob" })
      .toArray()
    expect(stored.map((order) => order.total).sort()).toEqual([3, 4])

    const refused = await client
      .insert("orders", { _id: "x1", tenantId: "kappa", ownerId: "bob", total: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refused).toMatchObject({ code: "CANOPY_POLICY_VIOLATION" })
    query.stop()
  })
})
