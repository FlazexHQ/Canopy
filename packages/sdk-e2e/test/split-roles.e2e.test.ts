import { createServer, request } from "node:http"
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
import { createClient as createGraphqlClient } from "graphql-ws"
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

const bun = (
  globalThis as {
    Bun?: {
      serve(options: ReturnType<Canopy["bun"]> & { port: number; hostname: string }): {
        readonly port: number
        stop(force?: boolean): void
      }
    }
  }
).Bun

interface Running {
  readonly canopy: Canopy
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
    if (role === "api" && bun !== undefined) {
      const server = bun.serve({ port: 0, hostname: "127.0.0.1", ...canopy.bun() })
      return {
        canopy,
        url: `http://127.0.0.1:${server.port}`,
        stop: async () => {
          await canopy.close()
          server.stop(true)
        },
      }
    }
    const server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return {
      canopy,
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

  it.each(["/rest/v1/notes", "/graphql", "/graphql/v1", "/auth/v1/session"])(
    "returns 404 for %s on the realtime service",
    async (path) => {
      const response = await fetch(`${realtime.url}${path}`)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("Not found")
    },
  )

  it("returns 404 for the realtime route on the api service", async () => {
    const response = await fetch(`${api.url}/realtime/v1`)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Not found")
  })

  it("rejects a GraphQL WebSocket upgrade on the realtime service", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const upgrade = request(`${realtime.url}/graphql/v1`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "graphql-transport-ws",
        },
        signal: AbortSignal.timeout(3000),
      })
      upgrade.on("response", (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      upgrade.on("upgrade", (response, socket) => {
        socket.destroy()
        resolve(response.statusCode)
      })
      upgrade.on("error", reject)
      upgrade.end()
    })
    expect(status).toBe(404)
  })

  it("enforces role paths for fetch and Bun handlers before calling a fallback", async () => {
    const fallback = () => new Response("fallback", { status: 200 })
    const server = {
      upgrade: () => {
        throw new Error("Unexpected WebSocket upgrade")
      },
    }
    const restRequest = new Request(`${realtime.url}/rest/v1/notes`)
    const realtimeRequest = new Request(`${api.url}/realtime/v1`, {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "canopy.v1+json" },
    })
    const responses = await Promise.all([
      realtime.canopy.fetch(restRequest, fallback),
      realtime.canopy.bun({ fallback }).fetch(restRequest, server),
      api.canopy.fetch(realtimeRequest, fallback),
      api.canopy.bun({ fallback }).fetch(realtimeRequest, server),
    ])
    for (const response of responses) {
      expect(response?.status).toBe(404)
      expect(await response?.text()).toBe("Not found")
    }
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

  it.each([
    {
      field: "liveNotes",
      selection: "_id title",
      first: [],
      changed: (id: string, title: string) => [{ _id: id, title }],
    },
    {
      field: "noteChanges",
      selection: "kind doc { _id title }",
      first: { kind: "READY", doc: null },
      changed: (id: string, title: string) => ({ kind: "ADDED", doc: { _id: id, title } }),
    },
  ])(
    "delivers a REST insert to $field over an API role GraphQL WebSocket and unsubscribes",
    async ({ field, selection, first, changed }) => {
      await until(() => realtime.canopy.realtime?.stats().subscriptions === 0)
      const title = `GraphQL split roles ${field}`
      const id = `graphql-public-${field}`
      await mongo
        .db(name)
        .collection<{ _id: string; ownerId: string; title: string }>("notes")
        .insertOne({ _id: `graphql-private-${field}`, ownerId: "bob", title })
      const client = createGraphqlClient({
        url: `${api.url.replace("http:", "ws:")}/graphql/v1`,
        connectionParams: { apikey: KEY, authorization: `Bearer ${token}` },
        lazy: false,
        retryAttempts: 0,
      })
      const stream = client.iterate({
        query: `subscription { ${field}(filter: { title: { eq: "${title}" } }) { ${selection} } }`,
      })
      try {
        expect(await stream.next()).toEqual({ done: false, value: { data: { [field]: first } } })
        expect(realtime.canopy.realtime?.stats().subscriptions).toBe(1)
        const inserted = await fetch(`${api.url}/rest/v1/notes`, {
          method: "POST",
          headers: {
            apikey: KEY,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ _id: id, ownerId: "alice", title }),
        })
        expect(inserted.status, await inserted.text()).toBe(201)
        expect(await stream.next()).toEqual({
          done: false,
          value: { data: { [field]: changed(id, title) } },
        })
        expect((await stream.return?.())?.done).toBe(true)
        await until(() => realtime.canopy.realtime?.stats().subscriptions === 0)
      } finally {
        await client.dispose()
      }
    },
  )

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
