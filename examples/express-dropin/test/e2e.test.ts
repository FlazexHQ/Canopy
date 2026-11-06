import { type ChildProcess, spawn } from "node:child_process"
import type { Server } from "node:http"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type CanopyClient, createClient, type Document, type QueryState } from "@canopy/client"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp, type HelpdeskApp } from "../src/app.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

const ROLES_CLAIM = "https://helpdesk.example/roles"
const AUDIENCE = "https://helpdesk.example/api"
const KEY = "pk_helpdesk_test"
const SCHEMA_FIELDS = [
  "__v",
  "_id",
  "createdAt",
  "internalNotes",
  "ownerId",
  "ownerName",
  "priority",
  "status",
  "title",
  "updatedAt",
]

interface Ticket extends Document {
  readonly title: string
  readonly ownerId: string
  readonly status: string
  readonly internalNotes?: string
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === "string") throw new Error("no port")
  return address.port
}

async function until(test: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

suite("express-dropin: the helpdesk behind the canopy-realtime sidecar", () => {
  const run = `${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const database = `helpdesk_e2e_${run}`
  const metaDatabase = `canopy_e2e_${run}`
  const policies = fileURLToPath(new URL("../canopy/policies", import.meta.url))
  let mongo: MongoClient
  let helpdesk: HelpdeskApp
  let server: Server
  let sidecar: ChildProcess
  let sidecarLog = ""
  let appUrl: string
  let sidecarUrl: string
  const clients: CanopyClient[] = []

  const tokenFor = async (user: string): Promise<string> => {
    const response = await fetch(`${appUrl}/dev/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user }),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  const api = async (
    user: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> & { _id?: string } }> => {
    const response = await fetch(`${appUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(user === undefined ? {} : { authorization: `Bearer ${await tokenFor(user)}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  }

  const watch = async (user: string): Promise<() => QueryState<Ticket>> => {
    const token = await tokenFor(user)
    const client = createClient({
      url: sidecarUrl,
      publishableKey: KEY,
      auth: { getToken: () => token },
    })
    clients.push(client)
    let state: QueryState<Ticket> | undefined
    client.live<Ticket>("tickets", {}, { sort: { updatedAt: -1 } }).subscribe((next) => {
      state = next
    })
    await until(() => state?.status === "ready", `${user}'s first snapshot`)
    return () => {
      if (state === undefined) throw new Error("no state")
      return state
    }
  }

  const titles = (state: QueryState<Ticket>): string[] =>
    state.data.map((ticket) => ticket.title).sort()

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const appPort = await freePort()
    const sidecarPort = await freePort()
    appUrl = `http://localhost:${appPort}`
    sidecarUrl = `http://127.0.0.1:${sidecarPort}`
    helpdesk = await createApp({
      port: appPort,
      mongodbUri: MONGODB_URI ?? "",
      database,
      identity: { kind: "dev", issuer: `${appUrl}/`, audience: AUDIENCE },
      rolesClaim: ROLES_CLAIM,
      canopyUrl: sidecarUrl,
      publishableKey: KEY,
      production: false,
    })
    server = await new Promise<Server>((resolve) => {
      const listening = helpdesk.app.listen(appPort, () => resolve(listening))
    })
    await api("alice", "GET", "/api/tickets")

    const realtime = dirname(
      createRequire(import.meta.url).resolve("@canopy/realtime/package.json"),
    )
    sidecar = spawn(
      process.execPath,
      ["--conditions=@canopy/source", join(realtime, "src", "bin", "canopy-realtime.ts")],
      {
        env: {
          ...process.env,
          MONGODB_URI: MONGODB_URI ?? "",
          CANOPY_DB: database,
          CANOPY_META_DB: metaDatabase,
          CANOPY_POLICIES: policies,
          CANOPY_PUBLISHABLE_KEYS: KEY,
          CANOPY_JWT_JWKS_URL: `${appUrl}/.well-known/jwks.json`,
          CANOPY_JWT_ISSUER: `${appUrl}/`,
          CANOPY_JWT_AUDIENCE: AUDIENCE,
          CANOPY_JWT_ROLES_CLAIM: ROLES_CLAIM,
          CANOPY_LOG_LEVEL: "warn",
          PORT: String(sidecarPort),
          METRICS_PORT: String(await freePort()),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    sidecar.stderr?.on("data", (chunk: Buffer) => {
      sidecarLog += chunk.toString()
    })
    const started = Date.now()
    for (;;) {
      if (sidecar.exitCode !== null) throw new Error(`The sidecar exited early:\n${sidecarLog}`)
      const ready = await fetch(`${sidecarUrl}/readyz`).then(
        (response) => response.ok,
        () => false,
      )
      if (ready) break
      if (Date.now() - started > 30_000)
        throw new Error(`The sidecar did not start:\n${sidecarLog}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })

  afterAll(async () => {
    for (const client of clients) client.close()
    if (sidecar !== undefined && sidecar.exitCode === null) {
      const exited = new Promise((resolve) => sidecar.once("exit", resolve))
      sidecar.kill("SIGTERM")
      await exited
    }
    await new Promise((resolve) => server?.close(resolve))
    await helpdesk?.close()
    if (mongo !== undefined) {
      await mongo.db(database).dropDatabase()
      await mongo.db(metaDatabase).dropDatabase()
      await mongo.close()
    }
  })

  it("rejects API calls without a valid token", async () => {
    expect((await api(undefined, "GET", "/api/tickets")).status).toBe(401)
    const forged = await fetch(`${appUrl}/api/tickets`, {
      headers: { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJkZXZ8c2FtIn0." },
    })
    expect(forged.status).toBe(401)
  })

  it("streams each user exactly the tickets the policy allows, with hidden fields removed", async () => {
    const alice = await watch("alice")
    const bob = await watch("bob")
    const sam = await watch("sam")
    expect(alice().data).toEqual([])

    expect((await api("bob", "POST", "/api/tickets", { title: "Printer jammed" })).status).toBe(201)
    const created = await api("alice", "POST", "/api/tickets", {
      title: "VPN drops",
      priority: "high",
    })
    expect(created.status).toBe(201)
    expect(created.json).not.toHaveProperty("internalNotes")
    const vpn = String(created.json._id)

    await until(() => alice().data.length === 1, "alice to see her ticket")
    await until(() => sam().data.length === 2, "support to see both tickets")
    await until(() => bob().data.length === 1, "bob to see his ticket")
    expect(titles(alice())).toEqual(["VPN drops"])
    expect(titles(bob())).toEqual(["Printer jammed"])
    expect(titles(sam())).toEqual(["Printer jammed", "VPN drops"])

    const noted = await api("sam", "PATCH", `/api/tickets/${vpn}`, {
      status: "in_progress",
      internalNotes: "Old VPN client, send the upgrade link",
    })
    expect(noted.status).toBe(200)
    await until(
      () => sam().data.some((t) => t.internalNotes === "Old VPN client, send the upgrade link"),
      "support to see the internal note",
    )
    await until(() => alice().data[0]?.status === "in_progress", "alice to see the status change")
    expect(alice().data[0]).not.toHaveProperty("internalNotes")
    expect(bob().data.map((t) => t.title)).toEqual(["Printer jammed"])

    expect((await api("alice", "PATCH", `/api/tickets/${vpn}`, { status: "closed" })).status).toBe(
      200,
    )
    await until(() => alice().data[0]?.status === "closed", "alice to see her ticket closed")
    await until(
      () => sam().data.find((t) => t.title === "VPN drops")?.status === "closed",
      "support to see the ticket closed",
    )
  })

  it("keeps the live view and the app's own REST endpoint in agreement", async () => {
    for (const user of ["alice", "bob", "sam"]) {
      const live = await watch(user)
      const rest = await api(user, "GET", "/api/tickets")
      const restTitles = (rest.json as unknown as { title: string }[]).map((t) => t.title).sort()
      expect(titles(live())).toEqual(restTitles)
      const restNotes = (rest.json as unknown as Record<string, unknown>[]).some(
        (t) => "internalNotes" in t,
      )
      expect(live().data.some((t) => "internalNotes" in t)).toBe(restNotes)
    }
  })

  it("enforces the app's own write rules, which the sidecar never bypasses", async () => {
    const bobs = await api("bob", "POST", "/api/tickets", { title: "Monitor flickers" })
    const id = String(bobs.json._id)
    expect((await api("alice", "PATCH", `/api/tickets/${id}`, { status: "closed" })).status).toBe(
      404,
    )
    expect(
      (await api("bob", "PATCH", `/api/tickets/${id}`, { internalNotes: "mine" })).status,
    ).toBe(403)
    expect((await api("bob", "PATCH", `/api/tickets/${id}`, { status: "done" })).status).toBe(400)
    const stored = await mongo
      .db(database)
      .collection("tickets")
      .findOne({ title: "Monitor flickers" })
    expect(stored?.["status"]).toBe("open")
    expect(stored?.["internalNotes"]).toBe("")
  })

  it("leaves the app database exactly as the app shaped it", async () => {
    const db = mongo.db(database)
    const collections = (await db.listCollections().toArray()).map((c) => c.name)
    expect(collections).toEqual(["tickets"])
    for (const ticket of await db.collection("tickets").find().toArray()) {
      expect(Object.keys(ticket).sort()).toEqual(SCHEMA_FIELDS)
    }
    const indexes = (await db.collection("tickets").indexes()).map((index) => index.name).sort()
    expect(indexes).toEqual(["_id_", "ownerId_1_updatedAt_-1", "updatedAt_-1"])
    expect(sidecarLog).not.toMatch(/"level":"error"/)
  })
})
