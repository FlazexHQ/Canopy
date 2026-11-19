import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, ctx, restrict, toStored } from "@canopy/policy"
import { canonicalString, toCanonical } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findGatewayBinary } from "../src/gateway.ts"
import { type Keys, makeKeys, sleep, TestClient, token } from "./harness.ts"

const BIN = fileURLToPath(new URL("../src/bin/canopy-realtime.ts", import.meta.url))
const ISSUER = "https://issuer.test/"
const AUDIENCE = "https://api.test"

const items = collection("items", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("own"),
    allow.read("admin").named("admins"),
    restrict
      .read("public")
      .where({ hidden: { $ne: true } })
      .named("hidden"),
  ],
  fields: { read: { default: { omit: ["secret"] }, admin: { only: ["*"] } } },
})
const teamDocs = collection("teamdocs", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ team: { $in: ctx("teams") } })],
})
const contexts = {
  teams: {
    from: "memberships",
    where: { userId: auth("sub") },
    select: "teamId",
    max: 10,
    ttl: "1m",
  },
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      )
    })
  })
}

interface Item {
  _id: number
  ownerId: string
  n: number
  hidden?: boolean
}

interface Server {
  readonly url: string
  readonly db: Db
  stop(): Promise<void>
}

async function start(kind: "ts" | "gateway", keys: Keys, dbName: string): Promise<Server> {
  const uri = MONGODB_URI ?? ""
  const dir = await mkdtemp(join(tmpdir(), `canopy-${kind}-`))
  const policies = join(dir, "policies")
  await import("node:fs/promises").then((fs) => fs.mkdir(policies))
  for (const def of [items, teamDocs]) {
    const stored = toCanonical(toStored(def, { version: 1 }))
    await writeFile(join(policies, `${def.collection}.json`), JSON.stringify(stored))
  }
  await writeFile(
    join(policies, "_context.json"),
    JSON.stringify({ _id: "_context", lookups: toCanonical(contexts) }),
  )
  const port = await freePort()
  const config = {
    mongodb: { uri, database: dbName, metaDatabase: `${dbName}_meta` },
    auth: {
      kind: "external",
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { keys: [keys.jwk] },
      rolesClaim: "roles",
    },
    keys: { publishable: ["pk_test"], secret: ["sk_test"] },
    policies: { dir: policies, watch: false },
    realtime: { checkpoints: "off", drainWindow: 100 },
    rateLimits: false,
    server: { port, metricsPort: await freePort() },
    log: { level: "error" },
  }
  const file = join(dir, "canopy.config.mjs")
  await writeFile(file, `export default ${JSON.stringify(config)}\n`)
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("CANOPY_") && entry[0] !== "MONGODB_URI" && entry[1] !== undefined,
    ),
  )
  if (kind === "gateway") env["CANOPY_REALTIME_SERVER"] = "gateway"
  const child: ChildProcess = spawn(
    process.execPath,
    ["--conditions=@canopy/source", BIN, "--config", file],
    { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] },
  )
  let log = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString()
  })
  const started = Date.now()
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${kind} exited early:\n${log}`)
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (response) => response.ok,
      () => false,
    )
    if (ready) break
    if (Date.now() - started > 60_000) throw new Error(`${kind} did not become ready:\n${log}`)
    await sleep(100)
  }
  const client = new MongoClient(uri)
  await client.connect()
  return {
    url: `ws://127.0.0.1:${port}/realtime/v1`,
    db: client.db(dbName),
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        child.kill("SIGTERM")
        await Promise.race([exited, sleep(5000)])
        if (child.exitCode === null) child.kill("SIGKILL")
      }
      await client.db(dbName).dropDatabase()
      await client.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const gatewayBuilt = findGatewayBinary() !== undefined
const servers: ("ts" | "gateway")[] = gatewayBuilt ? ["ts", "gateway"] : ["ts"]
const suite = MONGODB_URI === undefined ? describe.skip : describe

describe.skipIf(gatewayBuilt || MONGODB_URI === undefined)("canopy-gateway", () => {
  it.skip("is not built, so the conformance suite runs on the TypeScript engine only", () => {})
})

for (const kind of servers) {
  suite(`canopy-realtime conformance on the ${kind === "ts" ? "TypeScript engine" : "native gateway"}`, () => {
    let keys: Keys
    let server: Server
    const dbName = `canopy_conf_${kind}_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    const open: TestClient[] = []

    const connect = async (
      claims?: Record<string, unknown> | string,
      extra: Record<string, unknown> = {},
    ) => {
      const signed =
        typeof claims === "string" || claims === undefined ? claims : await token(keys, claims)
      const client = await TestClient.connect(server.url, signed, extra)
      open.push(client)
      return client
    }

    beforeAll(async () => {
      keys = await makeKeys()
      const client = new MongoClient(MONGODB_URI ?? "")
      await client.connect()
      await client
        .db(dbName)
        .collection("items")
        .insertMany([
          { _id: 1 as never, ownerId: "alice", n: 1, secret: "a1" },
          { _id: 2 as never, ownerId: "bob", n: 2, secret: "b2" },
          { _id: 3 as never, ownerId: "alice", n: 3, hidden: true },
          { _id: 4 as never, ownerId: "alice", n: 4 },
        ])
      await client
        .db(dbName)
        .collection("teamdocs")
        .insertMany([
          { _id: 1 as never, team: "t1", title: "one" },
          { _id: 2 as never, team: "t2", title: "two" },
        ])
      await client
        .db(dbName)
        .collection("memberships")
        .insertOne({ _id: "m1" as never, userId: "alice", teamId: "t1" })
      await client.close()
      server = await start(kind, keys, dbName)
    }, 120_000)

    afterAll(async () => {
      for (const client of open) client.bye()
      await server?.stop()
    }, 30_000)

    it("delivers a snapshot holding only what the policies allow, without unreadable fields", async () => {
      const alice = await connect({ sub: "alice" })
      await alice.subscribe("s", "items")
      expect(alice.ids("s").sort()).toEqual([1, 4])
      expect([...alice.view("s").values()].every((doc) => !("secret" in doc))).toBe(true)
      const admin = await connect({ sub: "root", roles: ["admin"] })
      await admin.subscribe("all", "items")
      expect(admin.ids("all").sort()).toEqual([1, 2, 4])
      expect([...admin.view("all").values()].some((doc) => doc["secret"] === "b2")).toBe(true)
    })

    it("streams changes, never a document the caller may not read, and removes one that leaves", async () => {
      const alice = await connect({ sub: "alice" })
      await alice.subscribe("live", "items")
      const items = server.db.collection<Item>("items")
      await items.insertOne({ _id: 10, ownerId: "bob", n: 10 })
      await items.insertOne({ _id: 11, ownerId: "alice", n: 11 })
      await alice.until(() => alice.ids("live").includes(11))
      await items.updateOne({ _id: 1 }, { $set: { n: 100 } })
      await alice.until(() => alice.view("live").get('items/{"$numberInt":"1"}')?.["n"] === 100)
      await items.updateOne({ _id: 4 }, { $set: { ownerId: "bob" } })
      await alice.until(() => !alice.ids("live").includes(4))
      await items.updateOne({ _id: 11 }, { $set: { hidden: true } })
      await alice.until(() => !alice.ids("live").includes(11))
      await items.deleteOne({ _id: 1 })
      await alice.until(() => !alice.ids("live").includes(1))
      await sleep(300)
      expect(alice.ids("live")).not.toContain(10)
      const leaked = alice.messages.some(
        (m) =>
          (m.t === "added" || m.t === "changed") && canonicalString(m.id) === canonicalString(10),
      )
      expect(leaked).toBe(false)
    })

    it("keeps a sorted window current", async () => {
      const admin = await connect({ sub: "root", roles: ["admin"] })
      await admin.subscribe("top", "items", { sort: { n: -1 }, limit: 2 })
      const before = admin.ids("top")
      expect(before).toHaveLength(2)
      await server.db.collection<Item>("items").insertOne({ _id: 50, ownerId: "x", n: 1000 })
      await admin.until(() => admin.ids("top").includes(50))
      expect(admin.ids("top")).toHaveLength(2)
    })

    it("moves a subscription when a context lookup changes", async () => {
      const alice = await connect({ sub: "alice" })
      await alice.subscribe("teams", "teamdocs")
      expect(alice.ids("teams")).toEqual([1])
      await server.db
        .collection<{ _id: string }>("memberships")
        .updateOne({ _id: "m1" }, { $set: { teamId: "t2" } })
      await alice.until(
        () => alice.ids("teams").includes(2) && !alice.ids("teams").includes(1),
        15_000,
      )
      expect(alice.messages.some((m) => m.t === "resync")).toBe(false)
    })

    it("refuses unknown collections and malformed queries with nosub", async () => {
      const alice = await connect({ sub: "alice" })
      await alice.subscribe("x", "nope")
      await alice.subscribe("y", "items", { filter: { $where: "1" } })
      const nosubs = alice.messages.filter((m) => m.t === "nosub")
      expect(nosubs.map((m) => (m.t === "nosub" ? m.err?.code : undefined))).toEqual([
        "CANOPY_NOT_FOUND",
        "CANOPY_INVALID_QUERY",
      ])
    })

    it("answers ping and refuses a bad token with 4001", async () => {
      const anon = await connect()
      expect(anon.welcome?.v).toBe(1)
      const bad = await TestClient.connect(server.url, "not.a.token")
      open.push(bad)
      await bad.until(() => bad.closeCode !== undefined)
      expect(bad.closeCode).toBe(4001)
    })

    it("resumes a session and replays what the client missed", async () => {
      const signed = await token(keys, { sub: "alice" })
      const alice = await connect(signed)
      await alice.subscribe("r", "items")
      const sid = alice.welcome?.sid
      const seq = alice.lastSeq
      alice.terminate()
      await sleep(200)
      await server.db.collection<Item>("items").insertOne({ _id: 60, ownerId: "alice", n: 60 })
      await sleep(500)
      const again = await connect(signed, { resume: { sid, seq } })
      expect(again.welcome?.resumed).toBe(true)
      await again.until(() =>
        again.messages.some(
          (m) => m.t === "added" && canonicalString(m.id) === canonicalString(60),
        ),
      )
      expect(Math.min(...again.messages.filter((m) => m.t !== "welcome").map((m) => m.seq))).toBe(
        seq + 1,
      )
    })
  })
}
