import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { attach, createRealtime } from "@canopy/realtime"
import { MONGODB_URI, TEST_ENGINE } from "@canopy/testing"
import {
  type CanopyClient,
  createClient,
  type QueryState,
  type WebSocketConstructor,
  type WebSocketLike,
} from "canopy.js"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  seedSplitPolicy,
  splitAudience,
  splitDatabase,
  splitIssuer,
  splitSigningKey,
  splitUrl,
} from "./split.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

interface Doc extends Document {
  _id: number
}

const sockets: WebSocketLike[] = []
const Tracked = class
  extends (globalThis as unknown as { WebSocket: WebSocketConstructor }).WebSocket
{
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols)
    sockets.push(this)
  }
} as WebSocketConstructor

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

suite("client against the realtime engine", () => {
  const dbName = splitUrl ? splitDatabase : `canopy_client_${process.pid}`
  let mongo: MongoClient
  let url: string
  let stop: (() => Promise<void>) | undefined
  let token: string

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "EdDSA" }
    token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "EdDSA", kid: splitUrl ? "dev" : "k" })
      .setIssuer(splitUrl ? splitIssuer : "iss")
      .setAudience(splitUrl ? splitAudience : "aud")
      .setExpirationTime("1h")
      .sign(splitUrl ? await splitSigningKey() : privateKey)
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const todos = collection("todos", {
      exposed: true,
      realtime: true,
      policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
    })
    if (splitUrl) {
      await seedSplitPolicy(mongo, todos, { apikey: "pk", authorization: `Bearer ${token}` })
      url = splitUrl
      return
    }
    const realtime = await createRealtime({
      engine: TEST_ENGINE,
      mongo,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      auth: { jwks: { keys: [jwk] }, issuer: "iss", audience: "aud" },
      policies: { set: createPolicySet([todos]) },
      checkpoints: "off",
      observerLingerMs: 0,
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
    if (splitUrl) {
      await mongo?.close()
      return
    }
    await stop?.()
    await mongo.db(dbName).dropDatabase()
    await mongo.close()
  })

  it("shows live, sorted, DLS filtered results and recovers from a dropped connection", async () => {
    const documents = mongo.db(dbName).collection<Doc>("todos")
    await documents.insertMany([
      { _id: 1, ownerId: "alice", rank: 2 },
      { _id: 2, ownerId: "bob", rank: 1 },
      { _id: 3, ownerId: "alice", rank: 1 },
    ])
    const client: CanopyClient = createClient({
      url,
      publishableKey: "pk",
      auth: { getToken: () => token },
      WebSocket: Tracked,
    })
    let state: QueryState | undefined
    const stopQuery = client
      .from("todos")
      .find({})
      .sort({ rank: 1 })
      .subscribe((next) => {
        state = next
      })
    await until(() => state?.status === "ready")
    expect(state?.data.map((doc) => doc["_id"])).toEqual([3, 1])
    expect(client.connectionStatus).toBe("live")

    await documents.insertOne({ _id: 4, ownerId: "alice", rank: 0 })
    await until(() => state?.data.length === 3)
    expect(state?.data.map((doc) => doc["_id"])).toEqual([4, 3, 1])

    sockets.at(-1)?.close(4500, "simulated failure")
    await until(() => client.connectionStatus === "reconnecting")
    expect(state?.status).toBe("stale")
    await documents.updateOne({ _id: 1 }, { $set: { rank: -1 } })
    await documents.deleteOne({ _id: 3 })
    await until(() => client.connectionStatus === "live" && state?.data.length === 2, 15_000)
    expect(state?.data.map((doc) => doc["_id"])).toEqual([1, 4])
    expect(state?.status).toBe("ready")
    expect(sockets.length).toBeGreaterThanOrEqual(2)

    stopQuery()
    client.close()
    expect(client.connectionStatus).toBe("closed")
  })
})
