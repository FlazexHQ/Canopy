import { compileFilter } from "@canopy/matcher"
import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import { canonicalString, ErrorCode, Long, ObjectId } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import fc from "fast-check"
import { BSON, type Collection, type Document } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  type Keys,
  makeKeys,
  type Running,
  sleep,
  startEngine,
  TestClient,
  token,
} from "./harness.ts"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("own"),
    allow
      .read("authenticated")
      .where({ orgId: { $in: auth("org_ids") }, shared: true })
      .named("shared"),
    allow.read("admin").named("admins read all"),
    restrict
      .read("public")
      .where({ hidden: { $ne: true } })
      .named("hidden is hidden"),
  ],
  fields: { read: { default: { omit: ["internalNotes"] }, admin: { only: ["*"] } } },
})
const archive = collection("archive", {
  exposed: true,
  realtime: false,
  policies: [allow.read("public")],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe
const SIM_SEEDS = Number(process.env["CANOPY_SIM_SEEDS"] ?? "5")
/** Two minutes plus half a second per seed (one takes about 50 ms), so the nightly 10k seeds can finish. */
const SIM_TIMEOUT = 120_000 + SIM_SEEDS * 500

interface Doc extends Document {
  _id: number
}

suite("realtime engine against MongoDB", () => {
  const uri = MONGODB_URI ?? ""
  const dbName = `canopy_rt_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let keys: Keys
  let engine: Running
  let alice: string
  let bob: string
  const clients: TestClient[] = []

  const documents = (): Collection<Doc> => engine.db.collection<Doc>("todos")

  const connect = async (tokenValue?: string): Promise<TestClient> => {
    const client = await TestClient.connect(engine.url, tokenValue)
    clients.push(client)
    return client
  }

  beforeAll(async () => {
    keys = await makeKeys()
    engine = await startEngine(uri, dbName, keys, [todos, archive])
    alice = await token(keys, { sub: "alice", org_ids: ["o1"] })
    bob = await token(keys, { sub: "bob", org_ids: ["o2"] })
  })

  afterAll(async () => {
    await engine.db.dropDatabase()
    await engine.client.db(`${dbName}_meta`).dropDatabase()
    await engine.stop()
  })

  beforeEach(async () => {
    await engine.db.collection("todos").deleteMany({})
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.bye()
  })

  it("sends a DLS filtered snapshot, then live changes, without hidden fields", async () => {
    await documents().insertMany([
      { _id: 1, ownerId: "alice", title: "a1", internalNotes: "secret" },
      { _id: 2, ownerId: "bob", title: "b1" },
      { _id: 3, ownerId: "bob", orgId: "o1", shared: true, title: "shared" },
      { _id: 4, ownerId: "alice", hidden: true, title: "hidden" },
    ])
    const client = await connect(alice)
    expect(client.welcome).toMatchObject({
      resumed: false,
      v: 1,
      pv: engine.realtime.policyVersion,
    })
    await client.subscribe("s1", "todos")
    expect(client.ids("s1").map(Number).sort()).toEqual([1, 3])
    expect(client.view("s1").get('todos/{"$numberInt":"1"}')).toEqual({
      _id: 1,
      ownerId: "alice",
      title: "a1",
    })

    await documents().insertOne({ _id: 5, ownerId: "alice", title: "new", internalNotes: "x" })
    await client.until(() => client.ids("s1").map(Number).includes(5))
    await documents().updateOne({ _id: 5 }, { $set: { title: "renamed", internalNotes: "y" } })
    await client.until(
      () => client.view("s1").get('todos/{"$numberInt":"5"}')?.["title"] === "renamed",
    )
    const changed = client.messages.filter((m) => m.t === "changed")
    expect(changed.at(-1)).toMatchObject({ t: "changed", set: { title: "renamed" } })
    expect(JSON.stringify(client.messages)).not.toContain("internalNotes")

    await documents().updateOne({ _id: 5 }, { $set: { hidden: true } })
    await client.until(() => !client.ids("s1").map(Number).includes(5))
    await documents().deleteOne({ _id: 1 })
    await client.until(() => !client.ids("s1").map(Number).includes(1))
    expect(client.ids("s1").map(Number)).toEqual([3])
  })

  it("runs snapshots for filters holding EJSON BSON values such as $oid and $numberLong", async () => {
    const hex = "6728f0c2a1b2c3d4e5f60718"
    await documents().insertMany([
      { _id: 1, ownerId: "alice", ref: new BSON.ObjectId(hex), n: BSON.Long.fromNumber(5) },
      { _id: 2, ownerId: "alice", ref: new BSON.ObjectId(), n: BSON.Long.fromNumber(5) },
      { _id: 3, ownerId: "alice", ref: new BSON.ObjectId(hex), n: BSON.Long.fromNumber(6) },
    ])
    const client = await connect(alice)
    await client.subscribe("s1", "todos", {
      filter: { ref: new ObjectId(hex), n: new Long(5n) },
    })
    expect(client.messages.some((m) => m.t === "nosub")).toBe(false)
    expect(client.ids("s1").map(Number)).toEqual([1])
    await documents().updateOne({ _id: 3 }, { $set: { n: BSON.Long.fromNumber(5) } })
    await client.until(() => client.ids("s1").map(Number).includes(3))
  })

  it("never sends a document to a subscriber the policy does not allow, nor removes one it never had", async () => {
    const client = await connect(bob)
    await client.subscribe("s1", "todos")
    await documents().insertMany([
      { _id: 10, ownerId: "alice", title: "private" },
      { _id: 11, ownerId: "bob", title: "mine" },
    ])
    await client.until(() => client.ids("s1").map(Number).includes(11))
    await documents().deleteOne({ _id: 10 })
    await documents().insertOne({ _id: 12, ownerId: "bob", title: "marker" })
    await client.until(() => client.ids("s1").map(Number).includes(12))
    const leaked = client.messages.filter(
      (m) =>
        (m.t === "added" || m.t === "changed" || m.t === "removed") &&
        canonicalString(m.id).includes("10"),
    )
    expect(leaked).toEqual([])
  })

  it("serves the full document to roles whose field rules allow it", async () => {
    await documents().insertOne({ _id: 20, ownerId: "x", title: "t", internalNotes: "n" })
    const admin = await connect(await token(keys, { sub: "root", roles: ["admin"] }))
    await admin.subscribe("s1", "todos")
    expect([...admin.view("s1").values()]).toEqual([
      { _id: 20, ownerId: "x", title: "t", internalNotes: "n" },
    ])
  })

  it("keeps a sorted, limited window current", async () => {
    await documents().insertMany(
      [1, 2, 3, 4, 5].map((n) => ({ _id: 100 + n, ownerId: "alice", rank: n })),
    )
    const client = await connect(alice)
    await client.subscribe("w", "todos", { sort: { rank: 1 }, limit: 2 })
    expect(client.ids("w").map(Number).sort()).toEqual([101, 102])
    await documents().insertOne({ _id: 100, ownerId: "alice", rank: 0 })
    await client.until(
      () => canonicalString(client.ids("w").map(Number).sort()) === canonicalString([100, 101]),
    )
    await documents().deleteMany({ _id: { $in: [100, 101] } })
    await client.until(
      () => canonicalString(client.ids("w").map(Number).sort()) === canonicalString([102, 103]),
    )
  })

  it("falls back to a polling observer for filters the matcher cannot run", async () => {
    const client = await connect(alice)
    await client.subscribe("p", "todos", { filter: { title: { $regex: "^(a)\\1" } } })
    expect(client.ready.has("p")).toBe(true)
    await documents().insertOne({ _id: 30, ownerId: "alice", title: "aab" })
    await client.until(() => client.ids("p").map(Number).includes(30))
    await documents().insertOne({ _id: 31, ownerId: "bob", title: "aac" })
    await sleep(600)
    expect(client.ids("p").map(Number)).toEqual([30])
  })

  it("rejects queries on unreadable fields, unknown collections and collections without realtime", async () => {
    const client = await connect(alice)
    await client.subscribe("a", "todos", { filter: { internalNotes: "x" } })
    await client.subscribe("b", "nope")
    await client.subscribe("c", "archive")
    await client.subscribe("d", "todos", { filter: { $where: "true" } })
    await client.subscribe("e", "todos", { filter: { $text: { $search: "x" } } })
    const nosubs = Object.fromEntries(
      client.messages.flatMap((m) => (m.t === "nosub" ? [[m.s, m.err?.code]] : [])),
    )
    expect(nosubs).toEqual({
      a: ErrorCode.InvalidQuery,
      b: ErrorCode.NotFound,
      c: ErrorCode.NotFound,
      d: ErrorCode.InvalidQuery,
      e: ErrorCode.InvalidQuery,
    })
    const text = client.messages.flatMap((m) =>
      m.t === "nosub" && m.s === "e" ? [m.err?.msg] : [],
    )
    expect(text[0]).toMatch(/\$text/)
  })

  it("refuses bad tokens and unknown keys", async () => {
    const forged = await token(await makeKeys(), { sub: "mallory" })
    const client = await connect(forged)
    await client.until(() => client.closeCode !== undefined)
    expect(client.closeCode).toBe(4001)
    const wrongKey = await TestClient.open(engine.url)
    clients.push(wrongKey)
    wrongKey.send({ t: "hello", v: 1, key: "pk_other" })
    await wrongKey.until(() => wrongKey.closeCode !== undefined)
    expect(wrongKey.closeCode).toBe(4001)
    const serviceClaim = await connect(await token(keys, { sub: "x", roles: ["service"] }))
    await serviceClaim.until(() => serviceClaim.closeCode !== undefined)
    expect(serviceClaim.closeCode).toBe(4003)
  })

  it("gives anon nothing unless a policy grants it", async () => {
    await documents().insertOne({ _id: 40, ownerId: "alice" })
    const client = await connect()
    await client.subscribe("s", "todos")
    expect(client.ids("s")).toEqual([])
  })

  it("resumes a session and replays the missed messages in order", async () => {
    const client = await connect(alice)
    await client.subscribe("s", "todos")
    const sid = client.welcome?.sid ?? ""
    const seq = client.lastSeq
    client.terminate()
    await sleep(100)
    await documents().insertOne({ _id: 50, ownerId: "alice", title: "while away" })
    await sleep(300)
    const again = await connect(alice)
    expect(again.welcome?.resumed).toBe(false)
    again.terminate()
    const resumed = await TestClient.connect(engine.url, alice, { resume: { sid, seq } })
    clients.push(resumed)
    expect(resumed.welcome).toMatchObject({ resumed: true, sid })
    await resumed.until(() => resumed.messages.some((m) => m.t === "added"))
    const replayed = resumed.messages.filter((m) => m.t !== "welcome")
    expect(replayed[0]?.seq).toBe(seq + 1)
    expect(replayed.map((m) => m.seq)).toEqual(replayed.map((_, index) => seq + 1 + index))
  })

  it("starts a new session when the resume position is unknown", async () => {
    const client = await TestClient.connect(engine.url, alice, {
      resume: { sid: "n1.unknown", seq: 3 },
    })
    clients.push(client)
    expect(client.welcome?.resumed).toBe(false)
    expect(client.welcome?.sid).not.toBe("n1.unknown")
  })

  it("resyncs subscriptions whose policy changed and keeps the others", async () => {
    await documents().insertOne({ _id: 60, ownerId: "alice", orgId: "o1", shared: true })
    const client = await connect(alice)
    await client.subscribe("s", "todos")
    const stricter = collection("todos", {
      exposed: true,
      realtime: true,
      policies: [
        allow
          .read("authenticated")
          .where({ ownerId: auth("sub"), shared: { $ne: true } })
          .named("own unshared"),
      ],
    })
    engine.realtime.reloadPolicies(createPolicySet([stricter, archive]))
    await client.until(() => client.messages.some((m) => m.t === "resync"))
    expect(client.messages.find((m) => m.t === "resync")).toMatchObject({
      reason: "policy",
      s: ["s"],
    })
    await client.subscribe("s", "todos")
    expect(client.ids("s")).toEqual([])
    engine.realtime.reloadPolicies(createPolicySet([todos, archive]))
  })

  it("applies an update to a document an earlier event of the same batch brought in", async () => {
    const coll = documents()
    const client = await connect(bob)
    await client.subscribe("s", "todos")
    const session = engine.client.startSession()
    try {
      await session.withTransaction(async () => {
        await coll.replaceOne({ _id: 5000 }, { ownerId: "bob", step: 1 }, { upsert: true, session })
        await coll.updateOne({ _id: 5000 }, { $set: { step: 2 } }, { session })
      })
    } finally {
      await session.endSession()
    }
    await coll.insertOne({ _id: 5001, ownerId: "bob", marker: true })
    await client.until(() => client.ids("s").map(Number).includes(5001))
    const held = [...client.view("s").values()].find((doc) => Number(doc["_id"]) === 5000)
    expect(held).toEqual({ _id: 5000, ownerId: "bob", step: 2 })
    await coll.deleteMany({ _id: { $in: [5000, 5001] } })
  })

  it(
    "converges to the MongoDB result after random writes (seeded simulation)",
    async () => {
      const coll = documents()
      const users = ["alice", "bob"]
      const tokens = { alice, bob }
      const filters = [{}, { done: true }, { rank: { $gte: 3 } }, { tags: "x" }]
      const write = fc.oneof(
        fc.record({
          op: fc.constant("insert" as const),
          id: fc.nat(30),
          owner: fc.constantFrom(...users),
          rank: fc.nat(5),
          done: fc.boolean(),
          tags: fc.subarray(["x", "y"]),
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
        fc.record({ op: fc.constant("delete" as const), id: fc.nat(30) }),
      )
      for (let seed = 0; seed < SIM_SEEDS; seed += 1) {
        await coll.deleteMany({})
        const writes =
          fc.sample(fc.array(write, { minLength: 20, maxLength: 60 }), { numRuns: 1, seed })[0] ??
          []
        const subscribers = await Promise.all(
          users.map((user) => connect(tokens[user as "alice" | "bob"])),
        )
        const half = Math.floor(writes.length / 2)
        const apply = async (w: (typeof writes)[number]): Promise<void> => {
          if (w.op === "insert") {
            await coll.replaceOne(
              { _id: w.id },
              { ownerId: w.owner, rank: w.rank, done: w.done, tags: w.tags },
              { upsert: true },
            )
          } else if (w.op === "update") {
            await coll.updateOne({ _id: w.id }, { $set: { rank: w.rank, done: w.done } })
          } else if (w.op === "move") {
            await coll.updateOne({ _id: w.id }, { $set: { ownerId: w.owner } })
          } else {
            await coll.deleteOne({ _id: w.id })
          }
        }
        const subscribing = subscribers.flatMap((client) =>
          filters.map((filter, index) => client.subscribe(`f${index}`, "todos", { filter })),
        )
        await Promise.all([...writes.slice(0, half).map(apply), ...subscribing])
        for (const w of writes.slice(half)) await apply(w)
        const markers = [1000 + seed * 2, 1001 + seed * 2]
        await coll.insertOne({ _id: markers[0] ?? 0, ownerId: "alice", marker: true })
        await coll.insertOne({ _id: markers[1] ?? 0, ownerId: "bob", marker: true })
        for (const [index, client] of subscribers.entries()) {
          await client.until(() =>
            client
              .ids("f0")
              .map(Number)
              .includes(markers[index] ?? -1),
          )
        }
        for (const [index, client] of subscribers.entries()) {
          const user = users[index] ?? ""
          for (const [fi, filter] of filters.entries()) {
            const expected = await coll
              .find({ $and: [filter, { ownerId: user }, { hidden: { $ne: true } }] })
              .sort({ _id: 1 })
              .toArray()
            const got = [...client.view(`f${fi}`).values()].sort(
              (a, b) => Number(a["_id"]) - Number(b["_id"]),
            )
            const gotText = got.map((doc) => canonicalString(doc))
            const expectedText = expected.map((doc) => canonicalString(doc))
            const differing = new Set(
              [...got, ...expected]
                .map((doc) => Number(doc["_id"]))
                .filter(
                  (id) =>
                    canonicalString(got.find((doc) => Number(doc["_id"]) === id) ?? null) !==
                    canonicalString(expected.find((doc) => Number(doc["_id"]) === id) ?? null),
                ),
            )
            const history = [...differing].map((id) => {
              const written = writes
                .map((w, index) => ({
                  index,
                  phase: index < half ? "concurrent" : "sequential",
                  ...w,
                }))
                .filter((w) => w.id === id)
              const received = client.messages.filter(
                (m) => "c" in m && "id" in m && Number(canonicalString(m.id)) === id,
              )
              return `document ${id}: writes ${JSON.stringify(written)}; messages ${received.map((m) => canonicalString(m)).join(" ")}`
            })
            expect(
              gotText,
              `seed ${seed}, ${user}, filter ${JSON.stringify(filter)}: got ${gotText.join(" ")}, MongoDB has ${expectedText.join(" ")}; ${history.join("; ")}`,
            ).toEqual(expectedText)
            for (const doc of got) expect(compileFilter({ ownerId: user }).matches(doc)).toBe(true)
          }
          client.bye()
        }
      }
    },
    SIM_TIMEOUT,
  )

  it("exposes Prometheus metrics", () => {
    const text = engine.realtime.renderMetrics()
    expect(text).toContain("# TYPE canopy_changestream_events_total counter")
    expect(text).toMatch(/canopy_changestream_events_total\{coll="todos",op="insert"\} \d+/)
  })
})

suite("no schema intrusion", () => {
  it("leaves the collections and indexes of the app database unchanged", async () => {
    const uri = MONGODB_URI ?? ""
    const dbName = `canopy_intrusion_${process.pid}`
    const keys = await makeKeys()
    const { MongoClient } = await import("mongodb")
    const setup = new MongoClient(uri)
    await setup.connect()
    const app = setup.db(dbName)
    await app.collection<Doc>("todos").insertOne({ _id: 1, ownerId: "alice" })
    await app.collection("todos").createIndex({ ownerId: 1 })
    const snapshot = async (): Promise<string> => {
      const collections = (await app.listCollections().toArray()).map((c) => c.name).sort()
      const indexes = await Promise.all(
        collections.map(async (name) => ({
          name,
          indexes: (await app.collection(name).indexes()).map((i) => i.name).sort(),
        })),
      )
      const docs = await app.collection("todos").find({}).toArray()
      return canonicalString({ collections, indexes, docs })
    }
    const before = await snapshot()
    const engine = await startEngine(uri, dbName, keys, [todos], { checkpoints: "meta" })
    const client = await TestClient.connect(engine.url, await token(keys, { sub: "alice" }))
    await client.subscribe("s", "todos", { sort: { ownerId: 1 }, limit: 5 })
    await client.subscribe("t", "todos", { filter: { title: { $regex: "(a)\\1" } } })
    await sleep(1200)
    client.terminate()
    await engine.stop()
    expect(await snapshot()).toBe(before)
    const meta = await setup.db(`${dbName}_meta`).listCollections().toArray()
    expect(meta.map((c) => c.name)).toContain("checkpoints")
    await app.dropDatabase()
    await setup.db(`${dbName}_meta`).dropDatabase()
    await setup.close()
  }, 60_000)
})
