import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { hashApiKey } from "@canopy/auth"
import { allow, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { ApiKeys, type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [allow.read("anon")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

interface Socket {
  readonly messages: Record<string, unknown>[]
  readonly closed: Promise<number>
  readonly socket: WebSocket
}

suite("stored API keys", () => {
  const dbName = `canopy_keys_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let meta: Db
  let canopy: Canopy
  let server: Server
  let base: string

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(metaName)
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
        keys: { publishable: ["pk_from_config"], secret: ["sk_from_config"] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
      }),
      { env: TEST_ENV, policies: createPolicySet([notes]), onSetupToken: false },
    )
    server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await mongo
      .db(dbName)
      .collection("notes")
      .insertOne({ _id: "n1" as never, body: "hi" })
  })

  afterAll(async () => {
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mongo.db(dbName).dropDatabase()
    await meta.dropDatabase()
    await mongo.close()
  })

  const rest = (key: string, path = "/notes") =>
    fetch(`${base}/rest/v1${path}`, { headers: { apikey: key } })

  const open = async (key: string): Promise<Socket> => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const messages: Record<string, unknown>[] = []
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)))
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    socket.send(JSON.stringify({ t: "hello", v: 1, key }))
    const started = Date.now()
    while (!messages.some((m) => m["t"] === "welcome" || m["t"] === "err")) {
      if (Date.now() - started > 5000) throw new Error("no welcome")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return { messages, closed, socket }
  }

  it("stores secret keys only as a hash and publishable keys in full", async () => {
    const secret = await canopy.keys.create({ kind: "secret", name: "ci", createdBy: "test" })
    const publishable = await canopy.keys.create({
      kind: "publishable",
      name: "web",
      createdBy: "test",
    })
    const raw = await meta.collection("api_keys").findOne({ _id: secret.info.id as never })
    expect(raw?.["hash"]).toBe(hashApiKey(secret.key))
    expect(raw?.["key"]).toBeUndefined()
    expect(JSON.stringify(raw)).not.toContain(secret.key.slice(18))
    expect(secret.info.prefix).toBe(secret.key.slice(10, 18))
    expect(secret.info.key).toBeUndefined()
    const listed = await canopy.keys.list()
    expect(listed.find((k) => k.id === publishable.info.id)?.key).toBe(publishable.key)
    expect(JSON.stringify(listed)).not.toContain(secret.key)
  })

  it("accepts stored keys next to config keys, with the right roles", async () => {
    const secret = await canopy.keys.create({ kind: "secret", name: "s", createdBy: "test" })
    const publishable = await canopy.keys.create({
      kind: "publishable",
      name: "p",
      createdBy: "test",
    })
    expect((await rest(publishable.key)).status).toBe(200)
    expect((await rest("pk_from_config")).status).toBe(200)
    const service = await fetch(`${base}/rest/v1/notes`, {
      method: "POST",
      headers: { apikey: secret.key, "content-type": "application/json" },
      body: JSON.stringify({ _id: "n2", body: "by service" }),
    })
    expect(service.status).toBe(201)
    const anon = await fetch(`${base}/rest/v1/notes`, {
      method: "POST",
      headers: { apikey: publishable.key, "content-type": "application/json" },
      body: JSON.stringify({ _id: "n3" }),
    })
    expect(anon.status).toBe(403)
    expect((await rest(`canopy_pk_${"x".repeat(32)}`)).status).toBe(401)
  })

  it("closes the sockets of a revoked key with 4003 within about a second and refuses it after", async () => {
    const doomed = await canopy.keys.create({
      kind: "publishable",
      name: "doomed",
      createdBy: "test",
    })
    const kept = await canopy.keys.create({ kind: "publishable", name: "kept", createdBy: "test" })
    const a = await open(doomed.key)
    const b = await open(doomed.key)
    const c = await open(kept.key)
    const d = await open("pk_from_config")
    expect(a.messages[0]?.["t"]).toBe("welcome")
    expect((await rest(doomed.key)).status).toBe(200)

    const started = Date.now()
    await meta
      .collection("api_keys")
      .updateOne({ _id: doomed.info.id as never }, { $set: { revokedAt: new Date() } })
    expect(await a.closed).toBe(4003)
    expect(await b.closed).toBe(4003)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(a.messages.some((m) => m["t"] === "err" && m["code"] === "CANOPY_FORBIDDEN")).toBe(true)
    expect(c.socket.readyState).toBe(WebSocket.OPEN)
    expect(d.socket.readyState).toBe(WebSocket.OPEN)

    const refused = await rest(doomed.key)
    expect(refused.status).toBe(403)
    const again = await open(doomed.key)
    expect(await again.closed).toBe(4003)
    expect((await rest(kept.key)).status).toBe(200)
    for (const socket of [c, d]) socket.socket.close()
  })

  it("also ends sessions when a key document is deleted", async () => {
    const gone = await canopy.keys.create({ kind: "publishable", name: "gone", createdBy: "test" })
    const socket = await open(gone.key)
    await meta.collection("api_keys").deleteOne({ _id: gone.info.id as never })
    expect(await socket.closed).toBe(4003)
    expect((await rest(gone.key)).status).toBe(401)
  })

  it("revoke() keeps the first revocation and reports unknown keys", async () => {
    const key = await canopy.keys.create({ kind: "secret", name: "r", createdBy: "test" })
    const first = await canopy.keys.revoke(key.info.id, "alice")
    const second = await canopy.keys.revoke(key.info.id, "bob")
    expect(second.revokedBy).toBe("alice")
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime())
    await expect(canopy.keys.revoke("key_missing", "bob")).rejects.toMatchObject({
      code: "CANOPY_NOT_FOUND",
    })
  })

  it("samples lastUsedAt instead of writing on every request", async () => {
    let now = 1_000_000
    const keys = new ApiKeys(meta, { now: () => now, flushMs: 3_600_000 })
    const created = await keys.create({ kind: "publishable", name: "sampled", createdBy: "test" })
    const record = await keys.find(created.key)
    expect(record).toEqual({ id: created.info.id, kind: "publishable", revoked: false })
    for (let i = 0; i < 50; i++) {
      now += 10
      keys.used({ id: created.info.id, kind: "publishable", revoked: false })
    }
    const before = await meta.collection("api_keys").findOne({ _id: created.info.id as never })
    expect(before?.["lastUsedAt"]).toBeUndefined()
    await keys.flush()
    const after = await meta.collection("api_keys").findOne({ _id: created.info.id as never })
    expect(after?.["lastUsedAt"]).toEqual(new Date(now))
    now -= 5000
    keys.used({ id: created.info.id, kind: "publishable", revoked: false })
    await keys.flush()
    const kept = await meta.collection("api_keys").findOne({ _id: created.info.id as never })
    expect(kept?.["lastUsedAt"]).toEqual(new Date(now + 5000))
    await keys.close()
  })
})
