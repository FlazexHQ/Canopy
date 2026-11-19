import * as policy from "@canopy/policy"
import { MongoClient } from "mongodb"
import { ReadPath } from "../src/index.ts"
import { closedLoop, emptySamples, summarize } from "./harness.ts"
import { benchPolicies, type Order, ownerOf, seedTo } from "./scenarios.ts"

const c = new MongoClient(
  process.env.CANOPY_BENCH_MONGODB_URI ?? "mongodb://localhost:27027/?replicaSet=rs0",
  { maxPoolSize: 200 },
)
await c.connect()
const db = c.db("canopy_pageload")
await db.dropDatabase()
const coll = db.collection<Order>("orders")
await coll.createIndexes([{ key: { ownerId: 1, createdAt: -1, _id: 1 } }])
await seedTo(coll, 0, 100000)
const reads = new ReadPath({
  client: c,
  database: "canopy_pageload",
  policies: benchPolicies(policy),
})
const r = () => Math.floor(Math.random() * 1000)
const ops = {
  driver: () =>
    coll
      .find({ ownerId: `u${r()}` })
      .sort({ createdAt: -1, _id: 1 })
      .limit(51)
      .toArray(),
  driverSnap: async () => {
    const s = c.startSession({ snapshot: true })
    try {
      return await coll
        .find(
          { ownerId: `u${r()}` },
          { session: s, maxTimeMS: 5000, promoteValues: false, bsonRegExp: true },
        )
        .sort({ createdAt: -1, _id: 1 })
        .limit(51)
        .toArray()
    } finally {
      await s.endSession()
    }
  },
  canopy: () =>
    reads.find(ownerOf(r()), { collection: "orders", sort: { createdAt: -1 }, limit: 50 }),
}
const conc = Number(process.env.CONC ?? "32")
const samples = Object.fromEntries(Object.keys(ops).map((k) => [k, emptySamples()]))
for (const op of Object.values(ops)) await closedLoop(1, conc, op)
for (let round = 0; round < 3; round++)
  for (const [k, op] of Object.entries(ops)) await closedLoop(2, conc, op, samples[k])
for (const k of Object.keys(ops)) {
  const s = summarize(samples[k] ?? emptySamples())
  process.stdout.write(
    `${k.padEnd(12)} ops/s ${s.perSecond}  cpu/op ${s.cpuPerOp.toFixed(3)} ms  p50 ${s.p50.toFixed(2)} ms  rounds ${s.rounds.join(" ")}
`,
  )
}
await db.dropDatabase()
await c.close()
