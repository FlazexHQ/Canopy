import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, context, createPolicySet, ctx } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.server.test/"
const AUDIENCE = "https://api.server.test"
const KEY = "pk_server_test"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})
const tasks = collection("tasks", {
  exposed: true,
  policies: [allow.read("authenticated").where({ projectId: { $in: ctx("projectIds") } })],
})
const lookups = context({
  projectIds: {
    from: "members",
    where: { userId: auth("sub") },
    select: "projectId",
    max: 10,
    ttl: "1h",
  },
})

type Doc = { _id: string; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("createCanopy against MongoDB", () => {
  const dbName = `canopy_server_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let db: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let sign: (sub: string) => Promise<string>
  let jwk: Record<string, unknown>

  const config = () =>
    defineConfig({
      mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
      auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
      keys: { publishable: [KEY] },
      realtime: { checkpoints: "off", drainWindow: "1s" },
    })

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    db = mongo.db(dbName)
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
    canopy = await createCanopy(config(), {
      env: TEST_ENV,
      policies: createPolicySet([notes, tasks], lookups),
      onSetupToken: false,
    })
    server = createServer(
      canopy.node({
        fallback: (_request, response) => {
          response.statusCode = 299
          response.end("app")
        },
      }),
    )
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await db.dropDatabase()
    await mongo.db(metaName).dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    for (const name of ["notes", "tasks", "members"]) await db.collection(name).deleteMany({})
  })

  const rest = async (user: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: KEY,
        authorization: `Bearer ${await sign(user)}`,
        "content-type": "application/json",
      },
    })

  const ids = async (response: Response): Promise<string[]> => {
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: Doc[] }).data.map((doc) => doc._id).sort()
  }

  it("serves REST with the configured policies and passes other paths to the app", async () => {
    await db.collection<Doc>("notes").insertMany([
      { _id: "a", ownerId: "alice" },
      { _id: "b", ownerId: "bob" },
    ])
    expect(await ids(await rest("alice", "/notes"))).toEqual(["a"])
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect(await (await fetch(`${base}/readyz`)).text()).toBe("ready")
    const app = await fetch(`${base}/anything`)
    expect(app.status).toBe(299)
    expect(await app.text()).toBe("app")
  })

  it("streams realtime over WebSocket and commits socket mutations through the REST write path", async () => {
    const token = await sign("alice")
    const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const messages: Record<string, unknown>[] = []
    const waitFor = (
      test: (m: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out: ${JSON.stringify(messages)}`)),
          10_000,
        )
        const check = (): void => {
          const found = messages.find(test)
          if (found === undefined) return
          clearTimeout(timer)
          resolve(found)
        }
        socket.on("message", check)
        check()
      })
    socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>),
    )
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    socket.send(JSON.stringify({ t: "hello", v: 1, key: KEY, token }))
    await waitFor((m) => m["t"] === "welcome")
    socket.send(JSON.stringify({ t: "sub", id: "s", c: "notes", q: {} }))
    await waitFor((m) => m["t"] === "ready")
    const mutationId = "0192f6a1-7c2e-7b1a-9d3e-0000000000a1"
    socket.send(
      JSON.stringify({
        t: "mut",
        id: mutationId,
        c: "notes",
        op: "insert",
        args: { doc: { _id: "m1", ownerId: "alice" } },
      }),
    )
    const ack = await waitFor((m) => m["t"] === "ack")
    expect(ack).toMatchObject({ ok: true, echo: true })
    expect(messages.some((m) => m["t"] === "added" && m["id"] === "m1")).toBe(true)
    const record = await mongo
      .db(metaName)
      .collection("mutations")
      .findOne({ _id: mutationId as never })
    expect(record).toMatchObject({ sub: "alice", c: "notes" })
    socket.close()
  })

  it("serves the SSE session endpoint for clients without WebSockets", async () => {
    const response = await fetch(`${base}/realtime/v1/sessions`, {
      method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${await sign("alice")}` },
      body: JSON.stringify({ v: 1 }),
    })
    expect(response.status).toBe(201)
    expect(((await response.json()) as { t: string }).t).toBe("welcome")
  })

  it("shares context lookups, so a membership change on the stream reaches REST at once", async () => {
    await db.collection<Doc>("tasks").insertMany([
      { _id: "t1", projectId: "p1" },
      { _id: "t2", projectId: "p2" },
    ])
    await db.collection<Doc>("members").insertOne({ _id: "m1", userId: "alice", projectId: "p1" })
    expect(await ids(await rest("alice", "/tasks"))).toEqual(["t1"])
    await db.collection<Doc>("members").insertOne({ _id: "m2", userId: "alice", projectId: "p2" })
    const deadline = Date.now() + 5000
    let seen: string[] = []
    while (Date.now() < deadline) {
      seen = await ids(await rest("alice", "/tasks"))
      if (seen.length === 2) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(seen).toEqual(["t1", "t2"])
  })

  it("serves GraphQL with the same policies, over HTTP and graphql-ws", async () => {
    await db.collection<Doc>("notes").insertMany([
      { _id: "g1", ownerId: "alice", text: "mine" },
      { _id: "g2", ownerId: "bob", text: "theirs" },
    ])
    const token = await sign("alice")
    const response = await fetch(`${base}/graphql/v1`, {
      method: "POST",
      headers: {
        apikey: KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "{ notes { nodes { _id text } } notesCount }" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { notes: { nodes: [{ _id: "g1", text: "mine" }] }, notesCount: 1 },
    })
    const anon = await canopy.fetch(
      new Request("http://canopy.test/graphql/v1", {
        method: "POST",
        headers: { apikey: KEY, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      }),
    )
    expect(await anon.json()).toEqual({ data: { __typename: "Query" } })

    const socket = new WebSocket(`${base.replace("http", "ws")}/graphql/v1`, "graphql-transport-ws")
    const messages: unknown[] = []
    const done = new Promise<void>((resolve, reject) => {
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as { type: string }
        messages.push(message)
        if (message.type === "connection_ack")
          socket.send(
            JSON.stringify({ id: "1", type: "subscribe", payload: { query: "{ notesCount }" } }),
          )
        if (message.type === "complete") resolve()
      })
      socket.on("error", reject)
    })
    await new Promise<void>((resolve) => socket.on("open", () => resolve()))
    socket.send(
      JSON.stringify({
        type: "connection_init",
        payload: { apikey: KEY, authorization: `Bearer ${token}` },
      }),
    )
    await done
    socket.close()
    expect(messages).toEqual([
      { type: "connection_ack" },
      { id: "1", type: "next", payload: { data: { notesCount: 1 } } },
      { id: "1", type: "complete" },
    ])
  })

  it("answers through the Web fetch handler too", async () => {
    await db.collection<Doc>("notes").insertOne({ _id: "f", ownerId: "bob" })
    const response = await canopy.fetch(
      new Request("http://canopy.test/rest/v1/notes", {
        headers: { apikey: KEY, authorization: `Bearer ${await sign("bob")}` },
      }),
    )
    expect(await ids(response)).toEqual(["f"])
    expect((await canopy.fetch(new Request("http://canopy.test/nope"))).status).toBe(404)
  })

  it("leaves out the sections the config turns off and keeps a shared client open", async () => {
    const restOnly = await createCanopy(
      { ...config(), realtime: false },
      { env: TEST_ENV, mongo, policies: createPolicySet([notes]), onSetupToken: false },
    )
    expect(restOnly.realtime).toBeUndefined()
    await db.collection<Doc>("notes").insertOne({ _id: "r", ownerId: "alice" })
    const response = await restOnly.fetch(
      new Request("http://canopy.test/rest/v1/notes", {
        headers: { apikey: KEY, authorization: `Bearer ${await sign("alice")}` },
      }),
    )
    expect(await ids(response)).toEqual(["r"])
    expect(
      (
        await restOnly.fetch(
          new Request("http://canopy.test/realtime/v1/sessions", { method: "POST" }),
        )
      ).status,
    ).toBe(404)
    await restOnly.close()
    expect(await db.collection("notes").countDocuments()).toBe(1)

    const realtimeOnly = await createCanopy(
      { ...config(), rest: false },
      { env: TEST_ENV, mongo, policies: createPolicySet([notes]), onSetupToken: false },
    )
    expect(realtimeOnly.rest).toBeUndefined()
    expect(realtimeOnly.graphql).toBeUndefined()
    expect((await realtimeOnly.fetch(new Request("http://canopy.test/rest/v1/notes"))).status).toBe(
      404,
    )
    await realtimeOnly.close()
  })

  it("reports not ready while the change stream is down, and draining once closing", async () => {
    const instance = await createCanopy(config(), {
      env: TEST_ENV,
      mongo,
      policies: createPolicySet([notes]),
      onSetupToken: false,
    })
    const readyz = async () => {
      const response = await instance.fetch(new Request("http://canopy.test/readyz"))
      return `${response.status} ${await response.text()}`
    }
    expect(await readyz()).toBe("200 ready")
    await instance.realtime?.close()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await readyz()).toBe("503 not ready: the change stream is not open")
    expect((await instance.fetch(new Request("http://canopy.test/healthz"))).status).toBe(200)
    await instance.close()
  })
})
