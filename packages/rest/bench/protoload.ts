import { isDeepStrictEqual } from "node:util"
import * as policy from "@canopy/policy"
import { MongoClient } from "mongodb"
import { WritePath } from "../src/index.ts"
import { closedLoop, emptySamples, summarize } from "./harness.ts"
import { benchPolicies, makeOrder, type Order, ownerOf, seedTo } from "./scenarios.ts"

const g = globalThis as { __proto?: boolean }
const say = (...parts: unknown[]): void => {
  process.stdout.write(`${parts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}
`)
}
const same = (label: string, a: unknown, b: unknown): void => {
  const ok = isDeepStrictEqual(a, b)
  say(`${label}: ${ok ? "same document" : "DIFFERENT"}`)
  if (!ok) process.exitCode = 1
}
type Docs = { readonly documents?: readonly unknown[] }
const withoutId = (d: unknown): unknown => {
  if (typeof d !== "object" || d === null) return d
  const { _id, ...rest } = d as Record<string, unknown>
  return rest
}
const c = new MongoClient(
  process.env.CANOPY_BENCH_MONGODB_URI ?? "mongodb://localhost:27027/?replicaSet=rs0",
  { maxPoolSize: 200 },
)
await c.connect()
const name = "canopy_protoload"
const db = c.db(name)
await db.dropDatabase()
await c.db(`${name}_meta`).dropDatabase()
const coll = db.collection<Order>("orders")
await coll.createIndexes([{ key: { ownerId: 1, createdAt: -1, _id: 1 } }])
await seedTo(coll, 0, 100000)
const writes = new WritePath({
  client: c,
  database: name,
  metaDatabase: `${name}_meta`,
  policies: benchPolicies(policy),
})
await writes.ensureIndexes()
const r = (n: number) => Math.floor(Math.random() * n)
let next = 1_000_000_000
// correctness: same document returned by both paths
{
  g.__proto = false
  const a: Docs = await writes.execute(ownerOf(43), {
    op: "update",
    collection: "orders",
    id: 43,
    update: { $inc: { n: 0 } },
  })
  g.__proto = true
  const b: Docs = await writes.execute(ownerOf(43), {
    op: "update",
    collection: "orders",
    id: 43,
    update: { $inc: { n: 0 } },
  })
  same("update returns", a.documents, b.documents)
  next += 1
  const base = { ...makeOrder(next), ownerId: "u1", tenantId: "t1" }
  g.__proto = false
  const x: Docs = await writes.execute(ownerOf(1), {
    op: "insert",
    collection: "orders",
    doc: base,
  })
  next += 1
  g.__proto = true
  const y: Docs = await writes.execute(ownerOf(1), {
    op: "insert",
    collection: "orders",
    doc: { ...base, _id: next },
  })
  same("insert returns (without _id)", withoutId(x.documents?.[0]), withoutId(y.documents?.[0]))
}
const upd =
  (flag: boolean, minimal = false) =>
  () => {
    g.__proto = flag
    const id = r(100000)
    return writes.execute(
      ownerOf(id % 1000),
      { op: "update", collection: "orders", id, update: { $inc: { n: 1 } } },
      minimal ? { returnDocuments: false } : {},
    )
  }
const ins =
  (flag: boolean, minimal = false) =>
  () => {
    g.__proto = flag
    next += 1
    return writes.execute(
      ownerOf(1),
      {
        op: "insert",
        collection: "orders",
        doc: { ...makeOrder(next), ownerId: "u1", tenantId: "t1" },
      },
      minimal ? { returnDocuments: false } : {},
    )
  }
const groups: Record<string, Record<string, () => Promise<unknown>>> = {
  update: {
    "driver updateOne": () => {
      const id = r(100000)
      return coll.updateOne(
        { _id: id, ownerId: `u${id % 1000}` },
        { $inc: { n: 1 } },
        { writeConcern: { w: "majority" } },
      )
    },
    "driver findOneAndUpdate (after)": () => {
      const id = r(100000)
      return coll.findOneAndUpdate(
        { _id: id, ownerId: `u${id % 1000}` },
        { $inc: { n: 1 } },
        { returnDocument: "after", writeConcern: { w: "majority" } },
      )
    },
    "canopy update today (2 cmds)": upd(false),
    "canopy update prototype (1 cmd)": upd(true),
    "canopy update return=minimal": upd(false, true),
  },
  insert: {
    "driver insertOne": () => {
      next += 1
      return coll.insertOne(
        { ...makeOrder(next), ownerId: "u1", tenantId: "t1" },
        { writeConcern: { w: "majority" } },
      )
    },
    "canopy insert today (2 cmds)": ins(false),
    "canopy insert prototype (1 cmd)": ins(true),
    "canopy insert prototype, return=minimal": ins(true, true),
  },
}
const STATUSES = ["open", "paid", "shipped", "closed"]
const clerkOf = (n: number) => ({
  context: {
    roles: new Set(["authenticated", "clerk"]),
    claims: { sub: `c${n}`, tenant: `t${n}` },
    now: new Date(),
  },
  subject: `c${n}`,
})
const chk = (flag: boolean) => () => {
  g.__proto = flag
  const id = r(100000)
  return writes.execute(clerkOf((id % 1000) % 100) as never, {
    op: "update",
    collection: "orders",
    id,
    update: { $set: { status: STATUSES[r(4)] } },
  })
}
const rep = (flag: boolean) => () => {
  g.__proto = flag
  const id = r(100000)
  const { _id, ...doc } = makeOrder(id)
  return writes.execute(ownerOf(id % 1000), {
    op: "replace",
    collection: "orders",
    id,
    doc: { ...doc, n: r(1000) },
  })
}
{
  const results: Docs[] = []
  for (const flag of [false, true]) {
    g.__proto = flag
    results.push(
      await writes.execute(clerkOf(44 % 100) as never, {
        op: "update",
        collection: "orders",
        id: 44,
        update: { $set: { status: "paid" } },
      }),
    )
    const { _id, ...doc } = makeOrder(45)
    results.push(
      await writes.execute(ownerOf(45), {
        op: "replace",
        collection: "orders",
        id: 45,
        doc: { ...doc, n: 7 },
      }),
    )
  }
  same("update with check returns", results[0]?.documents, results[2]?.documents)
  same("replace returns", results[1]?.documents, results[3]?.documents)
}
groups["check"] = {
  "driver updateOne": () => {
    const id = r(100000)
    return coll.updateOne(
      { _id: id, tenantId: `t${(id % 1000) % 100}` },
      { $set: { status: STATUSES[r(4)] } },
      { writeConcern: { w: "majority" } },
    )
  },
  "canopy update with check today (txn, 3 cmds)": chk(false),
  "canopy update with check prototype (1 cmd)": chk(true),
}
groups["replace"] = {
  "driver replaceOne": () => {
    const id = r(100000)
    return coll.replaceOne(
      { _id: id, ownerId: `u${id % 1000}` },
      { ...makeOrder(id), n: r(1000) },
      { writeConcern: { w: "majority" } },
    )
  },
  "canopy replace today (txn, 3 cmds)": rep(false),
  "canopy replace prototype (1 cmd)": rep(true),
}
if (process.env.GROUPS)
  for (const k of Object.keys(groups))
    if (!process.env.GROUPS.split(",").includes(k)) delete groups[k]
const out: Record<string, unknown> = {}
for (const [gname, ops] of Object.entries(groups)) {
  const samples = Object.fromEntries(Object.keys(ops).map((k) => [k, emptySamples()]))
  for (const op of Object.values(ops)) await closedLoop(1, 32, op)
  for (let round = 0; round < 4; round++)
    for (const [k, op] of Object.entries(ops)) await closedLoop(2, 32, op, samples[k])
  const ref = summarize(samples[Object.keys(ops)[0] ?? ""] ?? emptySamples()).perSecond
  for (const k of Object.keys(ops)) {
    const s = summarize(samples[k] ?? emptySamples())
    out[`${gname}: ${k}`] = { ...s, ratio: s.perSecond / ref }
    say(
      `${gname.padEnd(8)}${k.padEnd(46)} ops/s ${String(s.perSecond).padStart(5)}  ratio ${(s.perSecond / ref).toFixed(2)}  cpu/op ${s.cpuPerOp.toFixed(3)} ms  p50 ${s.p50.toFixed(2)} ms  errors ${s.errors}`,
    )
  }
}
await (await import("node:fs/promises")).writeFile(
  process.env.OUT ?? "protoload.json",
  JSON.stringify(out, null, 1),
)
await db.dropDatabase()
await c.db(`${name}_meta`).dropDatabase()
await c.close()
