import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { type ResolvedConfig, resolveConfig } from "@canopy/config"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import {
  type Canopy,
  createCanopy,
  defineConfig,
  planServerRole,
  type ServerRole,
} from "@canopy/server"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { type CanopyClient, createClient } from "canopy.js"
import { createRestClient } from "canopy.js/rest"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_split_roles"
const ISSUER = "https://idp.split-roles.test/"
const AUDIENCE = "https://api.split-roles.test"

async function until(test: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const notes = collection("notes", {
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

interface Running {
  readonly canopy: Canopy
  readonly server: Server
  readonly url: string
  stop(): Promise<void>
}

/**
 * The platform split into the services of the container stack: an `api` server and a `realtime` server
 * on one replica set, each its own process in production (here, its own server in this process).
 */
suite("the api and realtime roles as separate services", () => {
  const name = `canopy_split_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let token: string
  let realtime: Running
  let api: Running
  let apiStopped = false
  const clients: CanopyClient[] = []

  const resolved = (nodeId: string, jwk: Record<string, unknown>): ResolvedConfig =>
    resolveConfig(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: name, metaDatabase: `${name}_meta` },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      }),
      {
        env: { ...TEST_ENV, CANOPY_NODE_ID: nodeId },
        baseDir: ".",
        cwd: ".",
        command: "start",
      },
    ).config

  const start = async (
    config: ResolvedConfig,
    role: ServerRole,
    realtimeUrl?: string,
  ): Promise<Running> => {
    const plan = planServerRole(config, role, realtimeUrl)
    const canopy = await createCanopy(plan.config, {
      ...plan.options,
      env: TEST_ENV,
      policies: createPolicySet([notes]),
      onSetupToken: false,
    })
    const server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return {
      canopy,
      server,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stop: async () => {
        await canopy.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  const open = (): CanopyClient => {
    const client = createClient({
      url: realtime.url,
      publishableKey: KEY,
      auth: { getToken: () => token },
    })
    clients.push(client)
    return client
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }
    token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setExpirationTime("10m")
      .sign(pair.privateKey)
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    realtime = await start(resolved("realtime-1", jwk), "realtime")
    api = await start(resolved("api-1", jwk), "api", realtime.url)
  }, 120_000)

  afterAll(async () => {
    for (const client of clients.splice(0)) client.close()
    if (!apiStopped) await api?.stop()
    await realtime?.stop()
    await mongo?.db(name).dropDatabase()
    await mongo?.db(`${name}_meta`).dropDatabase()
    await mongo?.close()
  })

  it("runs no realtime engine in the api service and no admin API in the realtime service", async () => {
    expect(api.canopy.realtime).toBeUndefined()
    expect(realtime.canopy.realtime).toBeDefined()
    const admin = await fetch(`${realtime.url}/admin/v1/projects`)
    expect(admin.status).toBe(404)
    await admin.text()
    const ready = await fetch(`${api.url}/readyz`)
    expect(ready.status).toBe(200)
    await ready.text()
  })

  it("confirms a realtime mutation that the api service then reads over REST", async () => {
    const client = open()
    const live = client.from("notes").find({})
    const unsubscribe = live.subscribe(() => {})
    await until(() => live.getState().status === "ready")
    await client.insert("notes", { _id: "n1", ownerId: "alice", title: "from realtime" })
    const rest = createRestClient({ url: api.url, publishableKey: KEY, token: () => token })
    const found = await rest.from("notes").find({ _id: "n1" }).page()
    expect(found.data.map((doc) => doc["title"])).toEqual(["from realtime"])
    unsubscribe()
  })

  it("delivers a REST write of the api service to a live query of the realtime service", async () => {
    await mongo
      .db(name)
      .collection("notes")
      .insertOne({ _id: "n2" as never, ownerId: "alice", title: "draft" })
    const client = open()
    const live = client.from("notes").find({ title: "from rest" })
    const unsubscribe = live.subscribe(() => {})
    await until(() => live.getState().status === "ready")
    const rest = createRestClient({ url: api.url, publishableKey: KEY, token: () => token })
    await rest.from("notes").patch("n2", { title: "from rest" })
    await until(() => live.getState().data.some((doc) => doc["_id"] === "n2"))
    unsubscribe()
  })

  it("keeps realtime serving live queries after the api service stops", async () => {
    const client = open()
    const live = client.from("notes").find({ title: "after api" })
    const unsubscribe = live.subscribe(() => {})
    await until(() => live.getState().status === "ready")
    await api.stop()
    apiStopped = true
    const down = await fetch(`${api.url}/rest/v1/notes`).then(
      () => "answered",
      () => "refused",
    )
    expect(down).toBe("refused")
    await mongo
      .db(name)
      .collection("notes")
      .insertOne({ _id: "n3" as never, ownerId: "alice", title: "after api" })
    await until(() => live.getState().data.some((doc) => doc["_id"] === "n3"))
    await client.insert("notes", { _id: "n4", ownerId: "alice", title: "after api" })
    expect(
      (
        await mongo
          .db(name)
          .collection("notes")
          .findOne({ _id: "n4" as never })
      )?.["title"],
    ).toBe("after api")
    unsubscribe()
  })
})
