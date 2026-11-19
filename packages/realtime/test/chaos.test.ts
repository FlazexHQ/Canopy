import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, createPolicySet, toStored } from "@canopy/policy"
import { canonicalString, toCanonical } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { type Collection, type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findGatewayBinary, storedPolicies } from "../src/gateway.ts"
import { type Keys, makeKeys, sleep, TestClient, token } from "./harness.ts"

const BIN = fileURLToPath(new URL("../src/bin/canopy-realtime.ts", import.meta.url))
const GATEWAY = findGatewayBinary()
const ISSUER = "https://issuer.test/"
const AUDIENCE = "https://api.test"
/** The step down disturbs every suite sharing the replica set, so it runs only when asked for. */
const STEP_DOWN = process.env["CANOPY_CHAOS"] === "1"

const counters = collection("counters", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

interface Counter {
  _id: number
  ownerId: string
  n: number
}

type Kind = "ts" | "gateway"

interface Running {
  readonly url: string
  /** Kills the server process at once, as `kill -9` does: no drain, no close frames. */
  kill(): Promise<void>
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

/**
 * Starts the realtime server of `kind` with checkpoints on. The gateway is started directly rather than through
 * the sidecar, so killing it kills the process that holds the sockets.
 */
async function launch(kind: Kind, keys: Keys, dbName: string, dir: string): Promise<Running> {
  const uri = MONGODB_URI ?? ""
  const port = await freePort()
  const auth = {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { keys: [keys.jwk] },
    rolesClaim: "roles",
  }
  let child: ChildProcess
  if (kind === "gateway") {
    child = spawn(GATEWAY ?? "", ["--config", "-"], { stdio: ["pipe", "ignore", "pipe"] })
    child.stdin?.write(
      `${JSON.stringify({
        mongodb: { uri, database: dbName, metaDatabase: `${dbName}_meta` },
        server: { host: "127.0.0.1", port, metricsPort: 0 },
        auth,
        keys: { publishable: ["pk_test"], secret: [] },
        policies: storedPolicies(createPolicySet([counters])),
        realtime: { checkpoints: "meta", drainWindowMs: 100 },
        rateLimits: false,
        log: { level: "error" },
      })}\n`,
    )
  } else {
    const policies = join(dir, "policies")
    await mkdir(policies, { recursive: true })
    await writeFile(
      join(policies, "counters.json"),
      JSON.stringify(toCanonical(toStored(counters, { version: 1 }))),
    )
    const file = join(dir, "canopy.config.mjs")
    const config = {
      mongodb: { uri, database: dbName, metaDatabase: `${dbName}_meta` },
      auth: { kind: "external", ...auth },
      keys: { publishable: ["pk_test"], secret: ["sk_test"] },
      policies: { dir: policies, watch: false },
      realtime: { checkpoints: "meta", drainWindow: 100 },
      rateLimits: false,
      server: { port, metricsPort: await freePort() },
      log: { level: "error" },
    }
    await writeFile(file, `export default ${JSON.stringify(config)}\n`)
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          !entry[0].startsWith("CANOPY_") && entry[0] !== "MONGODB_URI" && entry[1] !== undefined,
      ),
    )
    child = spawn(process.execPath, ["--conditions=@canopy/source", BIN, "--config", file], {
      cwd: dir,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    })
  }
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
  return {
    url: `ws://127.0.0.1:${port}/realtime/v1`,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exited
    },
  }
}

/** The documents `owner` may read, as the client should hold them. */
async function oracle(coll: Collection<Counter>, owner: string): Promise<string[]> {
  return (await coll.find({ ownerId: owner }).toArray()).map((doc) => canonicalString(doc)).sort()
}

function held(client: TestClient, sub: string): string[] {
  return [...client.view(sub).values()].map((doc) => canonicalString(doc)).sort()
}

async function converge(
  client: TestClient,
  sub: string,
  coll: Collection<Counter>,
  owner: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const expected = await oracle(coll, owner)
    if (JSON.stringify(held(client, sub)) === JSON.stringify(expected)) return
    if (Date.now() > deadline) {
      expect(held(client, sub)).toEqual(expected)
      return
    }
    await sleep(100)
  }
}

const kinds: Kind[] = GATEWAY === undefined ? ["ts"] : ["ts", "gateway"]
const suite = MONGODB_URI === undefined ? describe.skip : describe

for (const kind of kinds) {
  suite(`realtime chaos on the ${kind === "ts" ? "TypeScript engine" : "native gateway"}`, () => {
    const dbName = `canopy_chaos_${kind}_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    let keys: Keys
    let mongo: MongoClient
    let db: Db
    let dir: string
    const running: Running[] = []
    const clients: TestClient[] = []

    const start = async (): Promise<Running> => {
      const server = await launch(kind, keys, dbName, dir)
      running.push(server)
      return server
    }

    beforeAll(async () => {
      keys = await makeKeys()
      dir = await mkdtemp(join(tmpdir(), `canopy-chaos-${kind}-`))
      mongo = new MongoClient(MONGODB_URI ?? "", { retryWrites: true })
      await mongo.connect()
      db = mongo.db(dbName)
    }, 60_000)

    afterAll(async () => {
      for (const client of clients) client.terminate()
      for (const server of running) await server.kill()
      await db?.dropDatabase()
      await mongo?.db(`${dbName}_meta`).dropDatabase()
      await mongo?.close()
      await rm(dir, { recursive: true, force: true })
    }, 60_000)

    it("loses no update when the server is killed and started again", async () => {
      const signed = await token(keys, { sub: "alice" })
      await db
        .collection("counters")
        .drop()
        .catch(() => undefined)
      const live = db.collection<Counter>("counters")
      await live.insertMany([
        ...[1, 2, 3, 4, 5].map((_id) => ({ _id, ownerId: "alice", n: 0 })),
        { _id: 6, ownerId: "bob", n: 0 },
      ])
      const first = await start()
      const alice = await TestClient.connect(first.url, signed)
      clients.push(alice)
      await alice.subscribe("c", "counters")
      expect(alice.ids("c").map(Number).sort()).toEqual([1, 2, 3, 4, 5])
      await live.updateMany({ ownerId: "alice" }, { $set: { n: 1 } })
      await converge(alice, "c", live, "alice")
      const sid = alice.welcome?.sid
      const seq = alice.lastSeq
      expect(sid).toBeDefined()

      await first.kill()
      await alice.until(() => alice.closeCode !== undefined)
      expect(alice.closeCode).toBe(1006)

      await live.updateMany({ _id: { $in: [1, 2, 3] } }, { $set: { n: 2 } })
      await live.deleteOne({ _id: 4 })
      await live.insertOne({ _id: 7, ownerId: "alice", n: 2 })
      await live.updateOne({ _id: 6 }, { $set: { ownerId: "alice" } })
      await live.updateOne({ _id: 5 }, { $set: { ownerId: "bob" } })

      const second = await start()
      const again = await TestClient.connect(second.url, signed, { resume: { sid, seq } })
      clients.push(again)
      expect(again.welcome?.resumed).not.toBe(true)
      expect(again.welcome?.sid).not.toBe(sid)
      await again.subscribe("c", "counters")
      expect(held(again, "c")).toEqual(await oracle(live, "alice"))

      await live.updateOne({ _id: 7 }, { $set: { n: 3 } })
      await live.updateOne({ _id: 6 }, { $set: { ownerId: "bob" } })
      await converge(again, "c", live, "alice")
      expect(again.messages.some((m) => m.t === "resync")).toBe(false)
      expect([...alice.invalid, ...again.invalid]).toEqual([])
    }, 120_000)

    it.skipIf(!STEP_DOWN)(
      "streams every write across a primary step down without a resync",
      async () => {
        await db
          .collection("counters")
          .drop()
          .catch(() => undefined)
        const live = db.collection<Counter>("counters")
        await live.insertMany([1, 2, 3, 4, 5].map((_id) => ({ _id, ownerId: "alice", n: 0 })))
        const server = await start()
        const alice = await TestClient.connect(server.url, await token(keys, { sub: "alice" }))
        clients.push(alice)
        await alice.subscribe("c", "counters")
        const admin = mongo.db("admin")
        const termOf = async (): Promise<number> =>
          Number((await admin.command({ replSetGetStatus: 1 }))["term"])
        const before = await termOf()

        let written = 0
        const writer = (async () => {
          for (let i = 1; i <= 80; i += 1) {
            for (;;) {
              try {
                await live.updateOne({ _id: (i % 5) + 1 }, { $set: { n: i } })
                written = i
                break
              } catch (error: unknown) {
                if (!(error instanceof Error)) throw error
                await sleep(200)
              }
            }
            await sleep(100)
          }
        })()
        await sleep(1000)
        try {
          await admin.command({ replSetStepDown: 5, secondaryCatchUpPeriodSecs: 1, force: true })
        } catch (error: unknown) {
          if (!(error instanceof Error)) throw error
        }
        await writer
        expect(written).toBe(80)
        for (;;) {
          const hello = await admin.command({ hello: 1 }).catch(() => undefined)
          if (hello?.["isWritablePrimary"] === true) break
          await sleep(200)
        }
        expect(await termOf()).toBeGreaterThan(before)
        await converge(alice, "c", live, "alice", 60_000)
        expect(alice.messages.some((m) => m.t === "resync")).toBe(false)
        expect(alice.closeCode).toBeUndefined()
        expect(alice.invalid).toEqual([])
      },
      180_000,
    )
  })
}
