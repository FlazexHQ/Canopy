import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { generateApiKey, hashApiKey } from "@canopy/auth"
import {
  allow,
  auth,
  collection,
  createPolicySet,
  ctx,
  explainAccess,
  explainContext,
  formatAccessReport,
  PolicyEngine,
  restrict,
  toFilter,
  toStored,
} from "@canopy/policy"
import { type ClientMessage, canonicalString, toCanonical } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import fc from "fast-check"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { findGatewayBinary } from "../src/gateway.ts"
import { type Keys, makeKeys, sleep, TestClient, token } from "./harness.ts"

const BIN = fileURLToPath(new URL("../src/bin/canopy-realtime.ts", import.meta.url))
const SERVER_BIN = fileURLToPath(new URL("../../server/src/bin/canopy-server.ts", import.meta.url))
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
const sim = collection("sim", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    restrict.read("public").where({ hidden: { $ne: true } }),
  ],
})
const SIM_SEEDS = Number(process.env["CANOPY_SIM_SEEDS"] ?? "5")
/**
 * Seeds that once failed, replayed before the others on every run. 1743 must come first: its first insert
 * creates the collection while the subscriptions read their snapshots. 1744 then finds sorted windows that
 * the deletes of the previous seed left short of their limit.
 */
const REGRESSION_SEEDS = [1743, 1744]

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
  /** The HTTP base of the realtime endpoints, for the SSE and long poll transports. */
  readonly base: string
  readonly db: Db
  readonly meta: Db
  stop(): Promise<void>
}

async function start(
  kind: "ts" | "gateway" | "server",
  keys: Keys,
  dbName: string,
): Promise<Server> {
  const uri = MONGODB_URI ?? ""
  const dir = await mkdtemp(join(tmpdir(), `canopy-${kind}-`))
  const policies = join(dir, "policies")
  await import("node:fs/promises").then((fs) => fs.mkdir(policies))
  for (const def of [items, teamDocs, sim]) {
    const stored = toCanonical(toStored(def, { version: 1 }))
    await writeFile(join(policies, `${def.collection}.json`), JSON.stringify(stored))
  }
  await writeFile(
    join(policies, "_context.json"),
    JSON.stringify({ _id: "_context", lookups: toCanonical(contexts) }),
  )
  const port = await freePort()
  const metaName = `${dbName}_meta`
  const config = {
    mongodb: { uri, database: dbName, metaDatabase: metaName },
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
    cors: { origins: ["https://app.test"] },
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
    ["--conditions=@canopy/source", kind === "server" ? SERVER_BIN : BIN, "--config", file],
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
    base: `http://127.0.0.1:${port}/realtime/v1`,
    db: client.db(dbName),
    meta: client.db(metaName),
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        child.kill("SIGTERM")
        await Promise.race([exited, sleep(5000)])
        if (child.exitCode === null) child.kill("SIGKILL")
      }
      await client.db(dbName).dropDatabase()
      await client.db(metaName).dropDatabase()
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

    it("accepts stored keys and closes their sessions when revoked or deleted", async () => {
      const keyed = kind === "gateway" ? server : await start("server", keys, `${dbName}_keys`)
      const collection = keyed.meta.collection<{
        _id: string
        kind: "publishable" | "secret"
        hash: string
        revokedAt?: Date
      }>("api_keys")
      const clients: TestClient[] = []
      const connectKey = async (
        key: string,
        signed?: string,
        resume?: { sid: string; seq: number },
      ) => {
        const client = await TestClient.connect(keyed.url, signed, { key, resume })
        clients.push(client)
        return client
      }
      try {
        const publishable = generateApiKey("publishable")
        const secret = generateApiKey("secret")
        await collection.insertMany([
          { _id: "key_publishable", kind: "publishable", hash: hashApiKey(publishable) },
          { _id: "key_secret", kind: "secret", hash: hashApiKey(secret) },
        ])
        const signed = await token(keys, { sub: "alice" })
        const anonymous = await connectKey(publishable)
        const authenticated = await connectKey(publishable, signed)
        const detached = await connectKey(publishable, signed)
        const service = await connectKey(secret, "a secret key takes precedence over a bad token")
        const configured = await connectKey("pk_test")
        for (const client of clients) expect(client.welcome).toBeDefined()
        const resume = { sid: detached.welcome?.sid ?? "", seq: detached.lastSeq }
        detached.terminate()
        await detached.until(() => detached.closeCode !== undefined)
        await collection.updateOne({ _id: "key_publishable" }, { $set: { revokedAt: new Date() } })
        for (const client of [anonymous, authenticated]) {
          await client.until(() => client.closeCode !== undefined)
          expect(client.closeCode).toBe(4003)
          expect(client.closeReason).toBe("The API key was revoked")
        }
        const refused = await connectKey(publishable)
        expect(refused.closeCode).toBe(4003)
        expect(refused.messages).toContainEqual(
          expect.objectContaining({ t: "err", code: "CANOPY_FORBIDDEN" }),
        )
        const fresh = await connectKey("pk_test", signed, resume)
        expect(fresh.welcome).toMatchObject({ resumed: false })
        await collection.deleteOne({ _id: "key_secret" })
        await service.until(() => service.closeCode !== undefined)
        expect(service.closeCode).toBe(4003)
        expect(service.closeReason).toBe("The API key was revoked")
        expect(configured.closeCode).toBeUndefined()
      } finally {
        for (const client of clients) client.bye()
        if (kind === "ts") await keyed.stop()
      }
    }, 30_000)

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

    it(
      "converges to the MongoDB result after random writes (seeded simulation)",
      async () => {
        const coll = server.db.collection<{
          _id: number
          ownerId?: string
          rank?: number
          done?: boolean
          hidden?: boolean
          marker?: boolean
        }>("sim")
        const users = ["alice", "bob"] as const
        const queries: Record<string, unknown>[] = [
          {},
          { filter: { done: true } },
          { filter: { rank: { $gte: 3 } } },
          { sort: { rank: -1 }, limit: 3 },
        ]
        const write = fc.oneof(
          fc.record({
            op: fc.constant("insert" as const),
            id: fc.nat(30),
            owner: fc.constantFrom(...users),
            rank: fc.nat(5),
            done: fc.boolean(),
            hidden: fc.boolean(),
          }),
          fc.record({
            op: fc.constant("update" as const),
            id: fc.nat(30),
            rank: fc.nat(5),
            done: fc.boolean(),
          }),
          fc.record({
            op: fc.constant("move" as const),
            id: fc.nat(30),
            owner: fc.constantFrom(...users),
          }),
          fc.record({ op: fc.constant("hide" as const), id: fc.nat(30), hidden: fc.boolean() }),
          fc.record({ op: fc.constant("delete" as const), id: fc.nat(30) }),
        )
        const seeds = [...REGRESSION_SEEDS, ...Array.from({ length: SIM_SEEDS }, (_, seed) => seed)]
        for (const seed of seeds) {
          await coll.deleteMany({})
          const writes =
            fc.sample(fc.array(write, { minLength: 20, maxLength: 60 }), { numRuns: 1, seed })[0] ??
            []
          const clients = await Promise.all(users.map((user) => connect({ sub: user })))
          const apply = async (w: (typeof writes)[number]): Promise<void> => {
            if (w.op === "insert")
              await coll.replaceOne(
                { _id: w.id },
                { ownerId: w.owner, rank: w.rank, done: w.done, hidden: w.hidden },
                { upsert: true },
              )
            else if (w.op === "update")
              await coll.updateOne({ _id: w.id }, { $set: { rank: w.rank, done: w.done } })
            else if (w.op === "move")
              await coll.updateOne({ _id: w.id }, { $set: { ownerId: w.owner } })
            else if (w.op === "hide")
              await coll.updateOne({ _id: w.id }, { $set: { hidden: w.hidden } })
            else await coll.deleteOne({ _id: w.id })
          }
          const half = Math.floor(writes.length / 2)
          const subscribing = clients.flatMap((client) =>
            queries.map((q, index) => client.subscribe(`q${index}`, "sim", q)),
          )
          await Promise.all([...writes.slice(0, half).map(apply), ...subscribing])
          for (const w of writes.slice(half)) await apply(w)
          for (const [index, client] of clients.entries()) {
            const marker = 1000 + seed * 10 + index
            await coll.insertOne({
              _id: marker,
              ownerId: users[index] ?? "",
              marker: true,
              rank: -1,
            })
            await client.until(() => client.ids("q0").map(Number).includes(marker), 15_000)
            await coll.deleteOne({ _id: marker })
            await client.until(() => !client.ids("q0").map(Number).includes(marker), 15_000)
          }
          for (const [index, client] of clients.entries()) {
            const user = users[index] ?? ""
            for (const [qi, q] of queries.entries()) {
              const visible = {
                $and: [
                  (q["filter"] as object | undefined) ?? {},
                  { ownerId: user },
                  { hidden: { $ne: true } },
                ],
              }
              let cursor = coll.find(visible)
              if (q["sort"] !== undefined)
                cursor = cursor.sort({ rank: -1, _id: 1 }).limit(Number(q["limit"]))
              else cursor = cursor.sort({ _id: 1 })
              const expected = (await cursor.toArray()).map((doc) => canonicalString(doc)).sort()
              const got = [...client.view(`q${qi}`).values()]
                .map((doc) => canonicalString(doc))
                .sort()
              expect(got, `seed ${seed}, ${user}, query ${JSON.stringify(q)}`).toEqual(expected)
            }
            client.bye()
          }
        }
      },
      120_000 + SIM_SEEDS * 5000,
    )

    it("explains a stated caller to a secret key exactly as the TypeScript policy engine does", async () => {
      const service = await connect(undefined, { key: "sk_test" })
      const filter = { n: { $gte: 1 } }
      const claims = { sub: "alice", roles: ["viewer"] }
      service.send({
        t: "sub",
        id: "why",
        c: "items",
        q: { filter },
        o: { explain: { claims, roles: ["admin"] } },
      } as ClientMessage)
      await service.until(() => service.ready.has("why"))
      const ready = service.messages.find((m) => m.t === "ready" && m.s === "why")
      const engine = new PolicyEngine(createPolicySet([items, teamDocs, sim], contexts))
      const report = explainAccess(engine, {
        collection: "items",
        op: "read",
        context: explainContext({ claims, roles: ["admin"] }),
        filter,
      })
      const expected = {
        ...report,
        effectiveFilter: toFilter(report.effective),
        text: formatAccessReport(report),
      }
      expect(canonicalString(ready?.t === "ready" ? ready.explain : undefined)).toBe(
        canonicalString(expected),
      )
      const user = await connect({ sub: "alice" })
      user.send({ t: "sub", id: "no", c: "items", q: {}, o: { explain: true } } as ClientMessage)
      await user.until(() => user.messages.some((m) => m.t === "nosub" && m.s === "no"))
      expect(user.messages.find((m) => m.t === "nosub" && m.s === "no")).toMatchObject({
        err: { code: "CANOPY_FORBIDDEN" },
      })
    })

    it("sent only frames the protocol decoder accepts", () => {
      expect(open.length).toBeGreaterThan(0)
      expect(open.flatMap((client) => client.invalid)).toEqual([])
    })

    describe("SSE and long polling", () => {
      interface Frame {
        readonly t: string
        readonly seq?: number
        readonly [key: string]: unknown
      }

      const call = (path: string, init: RequestInit = {}, key: string | null = "pk_test") =>
        fetch(`${server.base}${path}`, {
          ...init,
          headers: {
            ...(key === null ? {} : { apikey: key }),
            ...(init.headers as Record<string, string> | undefined),
          },
        })

      const openSession = async (claims: Record<string, unknown>, extra = {}) => {
        const response = await call("/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${await token(keys, claims)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ v: 1, sdk: "test", caps: ["diff", "batch"], ...extra }),
        })
        expect(response.status).toBe(201)
        return (await response.json()) as Frame & { sid: string; caps: string[]; resumed: boolean }
      }

      const post = (sid: string, messages: unknown[]) =>
        call(`/sessions/${sid}/messages`, { method: "POST", body: JSON.stringify(messages) })

      const poll = async (sid: string, after: number, wait = 5): Promise<Frame[]> => {
        const response = await call(`/sessions/${sid}/poll?after=${after}&wait=${wait}`)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe("application/json")
        return (await response.json()) as Frame[]
      }

      const pollUntil = async (sid: string, test: (frames: Frame[]) => boolean) => {
        const frames: Frame[] = []
        let after = 0
        const started = Date.now()
        while (!test(frames)) {
          if (Date.now() - started > 10_000) throw new Error(`timed out: ${JSON.stringify(frames)}`)
          const batch = await poll(sid, after, 2)
          frames.push(...batch)
          for (const frame of batch) if (frame.seq !== undefined) after = Math.max(after, frame.seq)
        }
        return frames
      }

      it("opens a session from headers, drops the batch capability and refuses bad credentials", async () => {
        const welcome = await openSession({ sub: "alice" })
        expect(welcome.t).toBe("welcome")
        expect(welcome.sid.startsWith("n1.")).toBe(true)
        expect(welcome.caps).not.toContain("batch")
        const badKey = await call("/sessions", { method: "POST", body: '{"v":1}' }, "pk_wrong")
        expect(badKey.status).toBe(401)
        expect(badKey.headers.get("content-type")).toBe("application/problem+json")
        expect(await badKey.json()).toMatchObject({ code: "CANOPY_UNAUTHORIZED", close: 4001 })
        const badToken = await call("/sessions", {
          method: "POST",
          headers: { authorization: "Bearer not.a.jwt" },
          body: '{"v":1}',
        })
        expect(badToken.status).toBe(401)
        expect(await badToken.json()).toMatchObject({ close: 4001 })
        expect((await call("/sessions", { method: "POST", body: '{"v":1}' }, null)).status).toBe(
          401,
        )
        expect((await call("/sessions", { method: "POST", body: "[1]" })).status).toBe(400)
      })

      it("delivers a snapshot and live changes over long polling, and redelivers a retried position", async () => {
        const { sid } = await openSession({ sub: "alice" })
        expect(
          (
            await post(sid, [
              { t: "sub", id: "p", c: "items", q: { filter: { n: { $gte: 200 } } } },
            ])
          ).status,
        ).toBe(202)
        const snapshot = await pollUntil(sid, (frames) => frames.some((f) => f.t === "ready"))
        const seqs = snapshot.map((frame) => frame.seq ?? 0)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        const again = await poll(sid, 0, 0)
        expect(again.map((frame) => frame.seq)).toEqual(snapshot.map((frame) => frame.seq))
        const last = Math.max(...seqs)
        const waiting = poll(sid, last, 5)
        await sleep(150)
        await server.db.collection<Item>("items").insertOne({ _id: 200, ownerId: "alice", n: 200 })
        await server.db.collection<Item>("items").insertOne({ _id: 201, ownerId: "bob", n: 201 })
        const live = await waiting
        expect(live).toEqual([expect.objectContaining({ t: "added", seq: last + 1 })])
        expect(canonicalString(live[0]?.["id"])).toBe(canonicalString(200))
        const gone = await call(`/sessions/${sid}/poll?after=0&wait=0`)
        expect(gone.status).toBe(410)
        expect(await gone.json()).toMatchObject({ close: 4000 })
        const started = Date.now()
        expect(await poll(sid, last + 1, 1)).toEqual([])
        expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      })

      it("streams server sent events whose ids are sequence numbers and resumes from Last-Event-ID", async () => {
        await server.db.collection<Item>("items").insertMany([
          { _id: 400, ownerId: "alice", n: 400 },
          { _id: 401, ownerId: "alice", n: 401 },
        ])
        const { sid } = await openSession({ sub: "alice" })
        await post(sid, [
          { t: "sub", id: "e", c: "items", q: { filter: { n: { $gte: 400 } }, sort: { _id: 1 } } },
        ])
        const read = async (headers: Record<string, string>) => {
          const controller = new AbortController()
          const response = await fetch(`${server.base}/sessions/${sid}/events`, {
            headers: { apikey: "pk_test", ...headers },
            signal: controller.signal,
          })
          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toBe("text/event-stream")
          const reader = (response.body as ReadableStream<Uint8Array>).getReader()
          const decoder = new TextDecoder()
          let text = ""
          while (!text.includes('"t":"ready"')) {
            const { value, done } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
          }
          controller.abort()
          return text
        }
        const first = await read({})
        expect(first.startsWith("retry: 1000\n\n")).toBe(true)
        const events = first
          .split("\n\n")
          .filter((block) => block.includes("data: "))
          .map((block) => ({
            id: /^id: (\d+)$/m.exec(block)?.[1],
            data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as Frame,
          }))
        expect(events.map((event) => event.data.t)).toEqual(["added", "added", "ready"])
        for (const event of events) expect(Number(event.id)).toBe(event.data.seq)
        const firstSeq = events[0]?.data.seq ?? 0
        const replay = await read({ "last-event-id": String(firstSeq) })
        expect(replay).not.toContain(`id: ${firstSeq}\n`)
        expect(replay).toContain(`id: ${firstSeq + 1}\n`)
      })

      it("needs the session key or a single use ticket, and routes other nodes away", async () => {
        const { sid } = await openSession({ sub: "alice" })
        expect((await call(`/sessions/${sid}/poll?wait=0`, {}, "pk_other")).status).toBe(401)
        expect((await call(`/sessions/${sid}/poll?wait=0`, {}, null)).status).toBe(401)
        const moved = await call("/sessions/n7.abc/poll?wait=0")
        expect(moved.status).toBe(409)
        expect(await moved.json()).toMatchObject({ code: "CANOPY_SESSION_MOVED" })
        expect((await call("/sessions/n1.abc/poll?wait=0")).status).toBe(404)
        expect((await call(`/sessions/${sid}/events`, { method: "POST" })).status).toBe(405)
        const issued = await call("/tickets", { method: "POST", body: JSON.stringify({ sid }) })
        expect(issued.status).toBe(201)
        const { ticket, expiresIn } = (await issued.json()) as { ticket: string; expiresIn: number }
        expect(expiresIn).toBe(30)
        expect((await call(`/sessions/${sid}/poll?wait=0&ticket=${ticket}`, {}, null)).status).toBe(
          200,
        )
        expect((await call(`/sessions/${sid}/poll?wait=0&ticket=${ticket}`, {}, null)).status).toBe(
          401,
        )
        const onPath = await call(`/sessions/${sid}/tickets`, { method: "POST" })
        expect(onPath.status).toBe(201)
        const other = await openSession({ sub: "alice" })
        const value = ((await onPath.json()) as { ticket: string }).ticket
        expect(
          (await call(`/sessions/${other.sid}/poll?wait=0&ticket=${value}`, {}, null)).status,
        ).toBe(401)
      })

      it("only takes client messages, and ends a session with DELETE", async () => {
        const { sid } = await openSession({ sub: "alice" })
        expect((await post(sid, [{ t: "hello", v: 1, key: "pk_test" }])).status).toBe(400)
        expect(
          (await call(`/sessions/${sid}/messages`, { method: "POST", body: "{}" })).status,
        ).toBe(400)
        expect((await call(`/sessions/${sid}`, { method: "DELETE" })).status).toBe(204)
        expect((await call(`/sessions/${sid}/poll?wait=0`)).status).toBe(404)
        const resumed = await openSession({ sub: "alice" }, { resume: { sid, seq: 0 } })
        expect(resumed.resumed).toBe(false)
        expect(resumed.sid).not.toBe(sid)
      })

      it("resumes a session on a new HTTP session and replays what the client missed", async () => {
        const { sid } = await openSession({ sub: "alice" })
        await post(sid, [{ t: "sub", id: "r", c: "items", q: { filter: { n: { $gte: 300 } } } }])
        const frames = await pollUntil(sid, (all) => all.some((f) => f.t === "ready"))
        const ready = frames.find((frame) => frame.t === "ready")?.seq ?? 0
        const resumed = await openSession({ sub: "alice" }, { resume: { sid, seq: ready - 1 } })
        expect(resumed).toMatchObject({ sid, resumed: true })
        expect((await poll(sid, ready - 1, 2)).map((frame) => frame.t)).toEqual(["ready"])
        await server.db.collection<Item>("items").insertOne({ _id: 300, ownerId: "alice", n: 300 })
        expect(await poll(sid, ready, 5)).toEqual([expect.objectContaining({ t: "added" })])
      })

      it("answers CORS preflights only for allowed origins", async () => {
        const preflight = (origin: string) =>
          call(
            "/sessions",
            { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } },
            null,
          )
        const allowed = await preflight("https://app.test")
        expect(allowed.status).toBe(204)
        expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test")
        expect(allowed.headers.get("access-control-allow-headers")).toContain("apikey")
        const denied = await preflight("https://evil.test")
        expect(denied.headers.get("access-control-allow-origin")).toBeNull()
        const refused = await call(
          "/sessions",
          { method: "POST", headers: { origin: "https://app.test" }, body: '{"v":1}' },
          "pk_wrong",
        )
        expect(refused.status).toBe(401)
        expect(refused.headers.get("access-control-allow-origin")).toBe("https://app.test")
      })
    })
  })
}
